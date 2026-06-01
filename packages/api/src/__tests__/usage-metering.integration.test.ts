import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getAdminPool, closePool } from '../db/client.js';
import { buildServer } from '../server.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const ownerUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof ownerUrl === 'string' && ownerUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const APP_PASSWORD = 'metering_test_app_pw';

function adminJwt(c: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: c.userId, tenantId: c.tenantId, facilityId: c.facilityId, role: 'admin' }),
  ).toString('base64url');
  return `Bearer ${header}.${payload}.signature`;
}

function appUrl(): string {
  const base = new URL(ownerUrl as string);
  base.username = 'claimflow_app';
  base.password = APP_PASSWORD;
  return base.toString();
}

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

async function truncate(pool: Pool): Promise<void> {
  const rows = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename NOT IN ('schema_migrations','payers','icd_codes','sha_service_codes')`,
  );
  if (rows.rows.length === 0) {
    return;
  }
  await pool.query(`TRUNCATE TABLE ${rows.rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  jwt: string;
}

async function seed(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid,$2,$3)`, [
    tenantId,
    'Meter Tenant',
    `tenant-${tenantId.slice(0, 8)}`,
  ]);
  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, sha_provider_id, tier_level, county, is_active)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,true)`,
    [facilityId, tenantId, 'Meter Facility', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'admin'::user_role,true,false)`,
    [userId, tenantId, facilityId, `meter.admin+${userId.slice(0, 8)}@example.org`, 'Meter Admin', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );
  return { tenantId, facilityId, userId, jwt: adminJwt({ tenantId, facilityId, userId }) };
}

integrationDescribe('Usage metering + per-tenant rate limiting (real Postgres, app role under RLS)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;

  beforeAll(async () => {
    if (!ownerUrl) {
      throw new Error('Integration database URL missing');
    }
    pool = getAdminPool(loadConfig({ exitOnError: false, env: { DATABASE_URL: ownerUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
    await runMigrations(pool);
    // Provision the app role with LOGIN so the metering writes run under RLS as
    // claimflow_app (not the owner) — proving the request-path path respects RLS.
    await pool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claimflow_app') THEN
           CREATE ROLE claimflow_app NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '${APP_PASSWORD}';
         ELSE ALTER ROLE claimflow_app LOGIN PASSWORD '${APP_PASSWORD}'; END IF;
       END $$;`,
    );

    // Build the server with a low per-tenant budget so the limit is reachable,
    // and APP_DATABASE_URL pointing at the app role (metering runs under RLS).
    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: ownerUrl,
        APP_DATABASE_URL: appUrl(),
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '100000',
        TENANT_RATE_LIMIT_RPM: '5',
        API_KEY_RATE_LIMIT_RPM: '3',
      },
    });
    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) {
      throw new Error('pool not initialized');
    }
    await truncate(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closePool();
  });

  it('meters requests and returns rate-limit headers', async () => {
    const s = await seed(pool!);
    const res = await app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: s.jwt } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(4);

    // A usage_counters row was written for this tenant (read back as owner).
    const counter = await pool!.query<{ request_count: string; principal_id: string }>(
      `SELECT request_count, principal_id FROM usage_counters WHERE tenant_id = $1::uuid`,
      [s.tenantId],
    );
    expect(counter.rows[0]?.request_count).toBe('1');
    expect(counter.rows[0]?.principal_id).toBe('-'); // human/JWT traffic
  });

  it('returns 429 once the per-tenant budget is exceeded', async () => {
    const s = await seed(pool!);
    // Budget is 5/min. Make 5 allowed, the 6th must 429.
    for (let i = 0; i < 5; i += 1) {
      const ok = await app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: s.jwt } });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: s.jwt } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('counts are not lost under concurrent requests (atomic increment)', async () => {
    const s = await seed(pool!);
    // Fire 20 concurrent requests against a budget of 5: exactly 5 should pass.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: s.jwt } }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200).length;
    const limited = results.filter((r) => r.statusCode === 429).length;
    expect(ok).toBe(5);
    expect(limited).toBe(15);

    // The counter equals the total requests (every request metered exactly once).
    const counter = await pool!.query<{ request_count: string }>(
      `SELECT request_count FROM usage_counters WHERE tenant_id = $1::uuid`,
      [s.tenantId],
    );
    expect(Number(counter.rows[0]?.request_count)).toBe(20);
  });

  it('isolates budgets per tenant', async () => {
    const a = await seed(pool!);
    const b = await seed(pool!);
    // Exhaust tenant A's budget.
    for (let i = 0; i < 6; i += 1) {
      await app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: a.jwt } });
    }
    const aBlocked = await app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: a.jwt } });
    expect(aBlocked.statusCode).toBe(429);
    // Tenant B is unaffected.
    const bOk = await app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: b.jwt } });
    expect(bOk.statusCode).toBe(200);
  });

  it('a per-principal policy overrides the default limit', async () => {
    const s = await seed(pool!);
    // Raise this tenant's default to 50 via a policy row (NULL principal).
    await pool!.query(
      `INSERT INTO rate_limit_policies (tenant_id, principal_id, route_class, max_per_minute)
       VALUES ($1::uuid, NULL, 'default', 50)`,
      [s.tenantId],
    );
    const res = await app!.inject({ method: 'GET', url: '/v1/claims', headers: { authorization: s.jwt } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('50');
  });

  it('does not meter unauthenticated public paths', async () => {
    const s = await seed(pool!);
    await app!.inject({ method: 'GET', url: '/health' });
    const counter = await pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM usage_counters WHERE tenant_id = $1::uuid`,
      [s.tenantId],
    );
    expect(counter.rows[0]?.count).toBe('0');
  });
});
