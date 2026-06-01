import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

// ============================================================================
// RLS GUARD (item 6c) — CI guardrail.
//
// Enumerates every table the application role can write to and FAILS if any of
// them lacks ENABLE + FORCE row-level security and at least one policy. This is
// the backstop against a future migration silently adding a tenant-scoped table
// (or granting the app role write access) without protecting it with RLS.
//
// A small, explicit allowlist names the tables that are deliberately NOT
// RLS-protected (global reference/catalog data). Anything else that is writable
// or tenant_id-bearing must be covered, or this test goes red.
// ============================================================================

const currentDir = dirname(fileURLToPath(import.meta.url));
const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

// Files allowed to reach the privileged (RLS-bypassing) pool. Everything else
// must use the tenant-scoped getTenantDb(). Keep this list tight — adding to it
// is a deliberate security decision, reviewed in the PR.
const PRIVILEGED_POOL_ALLOWLIST = new Set([
  'db/client.ts', // defines the accessors
  'db/privileged.ts', // the privileged accessor itself
  'plugins/auth.ts', // credential verification (pre-tenant-context)
  'routes/auth.ts', // login / refresh (pre-tenant-context)
  'routes/oauth.ts', // OAuth client verification (pre-tenant-context)
  'routes/api-keys.ts', // API-key management (auth surface)
  'routes/audit.ts', // constructs the background JobQueue (workers bind tenant per job)
  'routes/metrics.ts', // deliberately cross-tenant aggregate counts (no PHI rows)
  'jobs/setup.ts', // background workers: bind their own per-job tenant context
]);

// getAdminPool is migration/test-harness only and must never appear in app code.
const ADMIN_POOL_FORBIDDEN_IN_APP = 'getAdminPool';

// Global reference/catalog tables: shared across tenants, intentionally not
// RLS-restricted. The app role has SELECT-only on these (asserted separately).
const GLOBAL_REFERENCE_TABLES = new Set([
  'payers',
  'icd_codes',
  'sha_service_codes',
  'registry_cache',
  'tariffs',
  'tariff_versions',
  'rulepacks',
  'rulepack_rules',
]);

async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = resolve(currentDir, '../../../../migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [951337]);
    for (const file of files) {
      const sql = await readFile(resolve(migrationsDir, file), 'utf8');
      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${file}`, { cause: error as Error });
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [951337]);
    } catch {
      // ignore
    }
    client.release();
  }
}

interface RlsRow {
  tablename: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number;
}

integrationDescribe('RLS guard (real Postgres)', () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }
    pool = new Pool({ connectionString: integrationDatabaseUrl });
    await runMigrations(pool);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('every app-role-writable table has ENABLE + FORCE RLS and a policy', async () => {
    // Tables the claimflow_app role can INSERT into — the set that could leak if
    // unprotected. Derived from live grants, so a new GRANT is automatically in
    // scope for this assertion.
    const writable = await pool!.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.role_table_grants
        WHERE grantee = 'claimflow_app'
          AND privilege_type = 'INSERT'
          AND table_schema = 'public'`,
    );

    const rls = await pool!.query<RlsRow>(
      `SELECT c.relname AS tablename,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );

    const rlsByTable = new Map(rls.rows.map((r) => [r.tablename, r]));

    const offenders: string[] = [];
    for (const { table_name } of writable.rows) {
      if (GLOBAL_REFERENCE_TABLES.has(table_name)) {
        // A writable global table would itself be a mistake; flag it.
        offenders.push(`${table_name} (global table should be SELECT-only, but app role has INSERT)`);
        continue;
      }
      const info = rlsByTable.get(table_name);
      if (!info || !info.rls_enabled || !info.rls_forced || info.policy_count === 0) {
        offenders.push(
          `${table_name} (enabled=${info?.rls_enabled ?? false} forced=${info?.rls_forced ?? false} policies=${info?.policy_count ?? 0})`,
        );
      }
    }

    expect(offenders, `Tables writable by claimflow_app without ENABLE+FORCE RLS + a policy:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every tenant_id-bearing table the app role can SELECT has ENABLE + FORCE RLS and a policy', async () => {
    // Broader than the writable check: any table that (a) has a tenant_id column
    // and (b) the app role can read must be RLS-protected — a SELECT-only tenant
    // table without RLS would leak cross-tenant reads even though it is not
    // writable. (6c follow-up.)
    const readable = await pool!.query<{ table_name: string }>(
      `SELECT g.table_name
         FROM information_schema.role_table_grants g
         JOIN information_schema.columns col
           ON col.table_schema = g.table_schema
          AND col.table_name = g.table_name
          AND col.column_name = 'tenant_id'
        WHERE g.grantee = 'claimflow_app'
          AND g.privilege_type = 'SELECT'
          AND g.table_schema = 'public'
        GROUP BY g.table_name`,
    );

    const rls = await pool!.query<RlsRow>(
      `SELECT c.relname AS tablename,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    const rlsByTable = new Map(rls.rows.map((r) => [r.tablename, r]));

    const offenders: string[] = [];
    for (const { table_name } of readable.rows) {
      const info = rlsByTable.get(table_name);
      if (!info || !info.rls_enabled || !info.rls_forced || info.policy_count === 0) {
        offenders.push(
          `${table_name} (enabled=${info?.rls_enabled ?? false} forced=${info?.rls_forced ?? false} policies=${info?.policy_count ?? 0})`,
        );
      }
    }

    expect(
      offenders,
      `tenant_id tables readable by claimflow_app without ENABLE+FORCE RLS + a policy:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('global reference tables are SELECT-only for the app role (no write grants)', async () => {
    const writeGrants = await pool!.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'claimflow_app'
          AND privilege_type IN ('INSERT','UPDATE','DELETE')
          AND table_schema = 'public'`,
    );
    const violations = writeGrants.rows
      .filter((r) => GLOBAL_REFERENCE_TABLES.has(r.table_name))
      .map((r) => `${r.table_name}:${r.privilege_type}`);
    expect(violations, `Global tables must not be writable by app role: ${violations.join(', ')}`).toEqual([]);
  });

  it('the app role is neither superuser nor BYPASSRLS', async () => {
    const role = await pool!.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'claimflow_app'`,
    );
    expect(role.rows[0]).toBeDefined();
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
  });
});

// Static source guard — always runs (no DB needed). Ensures app code can't
// quietly reach an RLS-bypassing pool outside the reviewed allowlist.
describe('RLS import guard (static source scan)', () => {
  async function walk(dir: string, acc: string[] = []): Promise<string[]> {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const full = resolve(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') {
          continue;
        }
        await walk(full, acc);
      } else if (entry.endsWith('.ts')) {
        acc.push(full);
      }
    }
    return acc;
  }

  it('only allowlisted files import getPrivilegedPool', async () => {
    const srcDir = resolve(currentDir, '..');
    const files = await walk(srcDir);
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(srcDir, file).replace(/\\/g, '/');
      const contents = await readFile(file, 'utf8');
      if (contents.includes('getPrivilegedPool') && !PRIVILEGED_POOL_ALLOWLIST.has(rel)) {
        violations.push(rel);
      }
    }
    expect(violations, `Unallowlisted files importing the privileged pool:\n${violations.join('\n')}`).toEqual([]);
  });

  it('getAdminPool is never used in application code (migration/test-harness only)', async () => {
    const srcDir = resolve(currentDir, '..');
    const files = await walk(srcDir);
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(srcDir, file).replace(/\\/g, '/');
      // db/client.ts defines it; everything else under src/ is app code.
      if (rel === 'db/client.ts') {
        continue;
      }
      const contents = await readFile(file, 'utf8');
      if (contents.includes(ADMIN_POOL_FORBIDDEN_IN_APP)) {
        violations.push(rel);
      }
    }
    expect(violations, `getAdminPool must not appear in app code:\n${violations.join('\n')}`).toEqual([]);
  });
});
