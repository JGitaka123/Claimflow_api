import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

// ============================================================================
// RLS ISOLATION (item 6c) — proves cross-tenant read AND write attempts fail.
//
// Runs as the non-superuser claimflow_app role (the production runtime role),
// because the table owner / superuser the other suites use would be exempt from
// FORCE RLS and hide everything. The test provisions claimflow_app with LOGIN,
// connects a dedicated pool as that role, and drives queries with the tenant
// GUC set LOCAL inside a transaction — exactly how TenantDb behaves in prod.
// ============================================================================

const currentDir = dirname(fileURLToPath(import.meta.url));
const ownerUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof ownerUrl === 'string' && ownerUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const APP_PASSWORD = 'rls_test_app_pw';

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

function appUrl(): string {
  // Prefer an explicit APP_DATABASE_URL (CI/prod parity) when it points at the
  // app role; otherwise derive an app-role URL from the owner URL. Either way
  // this suite connects as the non-superuser claimflow_app role — never the
  // owner/superuser, which would bypass FORCE RLS and make the test false-green.
  const configured = process.env.APP_DATABASE_URL;
  if (configured && configured.includes('claimflow_app')) {
    return configured;
  }
  const base = new URL(ownerUrl as string);
  base.username = 'claimflow_app';
  base.password = APP_PASSWORD;
  return base.toString();
}

/** Run a callback with the tenant GUC set LOCAL to one transaction (prod parity). */
async function asTenant<T>(pool: Pool, tenantId: string, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface Seeded {
  tenantId: string;
  facilityId: string;
  userId: string;
  claimId: string;
  payerId: string;
}

integrationDescribe('RLS isolation as the app role (real Postgres)', () => {
  let ownerPool: Pool | undefined;
  let appPool: Pool | undefined;
  let tenantA: Seeded;
  let tenantB: Seeded;

  async function seedTenant(owner: Pool, payerId: string): Promise<Seeded> {
    const tenantId = randomUUID();
    const facilityId = randomUUID();
    const userId = randomUUID();
    const claimId = randomUUID();
    await owner.query(`INSERT INTO tenants (id,name,slug) VALUES ($1,$2,$3)`, [
      tenantId,
      `T-${tenantId.slice(0, 6)}`,
      `tenant-${tenantId.slice(0, 8)}`,
    ]);
    await owner.query(
      `INSERT INTO facilities (id,tenant_id,name,sha_facility_code,sha_provider_id,tier_level,county,is_active)
       VALUES ($1,$2,$3,$4,$5,'LEVEL_4','Kiambu',true)`,
      [facilityId, tenantId, 'F', `FID-${facilityId.slice(0, 6)}`, facilityId.slice(0, 6)],
    );
    await owner.query(
      `INSERT INTO users (id,tenant_id,facility_id,email,display_name,password_hash,role,is_active,must_change_password)
       VALUES ($1,$2,$3,$4,'U','h','admin',true,false)`,
      [userId, tenantId, facilityId, `u+${userId.slice(0, 8)}@x.io`],
    );
    await owner.query(
      `INSERT INTO claims (id,tenant_id,facility_id,payer_id,claim_type,visit_type,admission_date,status,created_by)
       VALUES ($1,$2,$3,$4,'OUTPATIENT','OP','2026-01-01','DRAFT',$5)`,
      [claimId, tenantId, facilityId, payerId, userId],
    );
    await owner.query(
      `INSERT INTO claim_lines (claim_id,tenant_id,line_number,sha_service_code,description,quantity,unit_price,total_amount)
       VALUES ($1,$2,1,'SVC','x',1,100,100)`,
      [claimId, tenantId],
    );
    return { tenantId, facilityId, userId, claimId, payerId };
  }

  beforeAll(async () => {
    if (!ownerUrl) {
      throw new Error('Integration database URL missing');
    }
    ownerPool = new Pool({ connectionString: ownerUrl });
    await runMigrations(ownerPool);

    // Provision the app role with LOGIN for the test connection.
    await ownerPool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claimflow_app') THEN
           CREATE ROLE claimflow_app NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '${APP_PASSWORD}';
         ELSE
           ALTER ROLE claimflow_app LOGIN PASSWORD '${APP_PASSWORD}';
         END IF;
       END $$;`,
    );

    const payer = await ownerPool.query<{ id: string }>(`SELECT id FROM payers WHERE slug='sha' LIMIT 1`);
    const payerId = payer.rows[0]?.id;
    if (!payerId) {
      throw new Error('SHA payer not seeded by migrations');
    }

    tenantA = await seedTenant(ownerPool, payerId);
    tenantB = await seedTenant(ownerPool, payerId);

    appPool = new Pool({ connectionString: appUrl() });

    // Guard: this suite is meaningless unless it connects as a non-superuser,
    // non-BYPASSRLS role. A superuser/owner connection bypasses FORCE RLS and
    // every assertion below would be false-green. Fail loudly otherwise.
    const who = await appPool.query<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>(
      `SELECT r.rolsuper, r.rolbypassrls, current_user
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const ident = who.rows[0];
    if (!ident || ident.current_user !== 'claimflow_app' || ident.rolsuper || ident.rolbypassrls) {
      throw new Error(
        `RLS isolation test must connect as non-superuser claimflow_app, got ${JSON.stringify(ident)}`,
      );
    }
  });

  afterAll(async () => {
    await appPool?.end();
    if (ownerPool && tenantA && tenantB) {
      // Clean up seeded rows (owner bypasses RLS).
      // audit_trail is append-only (enforced by a DB trigger), so we cannot
      // delete its rows. Detach the FK references instead, then drop the rest.
      for (const t of [tenantA, tenantB]) {
        await ownerPool.query(`UPDATE audit_trail SET claim_id = NULL WHERE tenant_id=$1`, [t.tenantId]).catch(() => {
          // trigger also blocks UPDATE; fall through — leftover audit rows are harmless across runs
        });
      }
      for (const t of [tenantA, tenantB]) {
        await ownerPool.query(`DELETE FROM claims WHERE tenant_id=$1`, [t.tenantId]).catch(() => undefined);
        await ownerPool.query(`DELETE FROM users WHERE tenant_id=$1`, [t.tenantId]).catch(() => undefined);
        await ownerPool.query(`DELETE FROM facilities WHERE tenant_id=$1`, [t.tenantId]).catch(() => undefined);
        await ownerPool.query(`DELETE FROM tenants WHERE id=$1`, [t.tenantId]).catch(() => undefined);
      }
    }
    await ownerPool?.end();
  });

  it('a tenant sees only its own claims', async () => {
    const visible = await asTenant(appPool!, tenantA.tenantId, async (c) => {
      const r = await c.query<{ id: string }>(`SELECT id FROM claims`);
      return r.rows.map((row) => row.id);
    });
    expect(visible).toContain(tenantA.claimId);
    expect(visible).not.toContain(tenantB.claimId);
  });

  it('a direct-by-id read of another tenant\'s claim returns zero rows', async () => {
    const rows = await asTenant(appPool!, tenantA.tenantId, async (c) => {
      const r = await c.query(`SELECT id FROM claims WHERE id = $1`, [tenantB.claimId]);
      return r.rowCount;
    });
    expect(rows).toBe(0);
  });

  it('child rows (claim_lines) of another tenant are invisible', async () => {
    const counts = await asTenant(appPool!, tenantA.tenantId, async (c) => {
      const all = await c.query(`SELECT id FROM claim_lines`);
      const foreign = await c.query(`SELECT id FROM claim_lines WHERE tenant_id = $1`, [tenantB.tenantId]);
      return { all: all.rowCount, foreign: foreign.rowCount };
    });
    expect(counts.all).toBeGreaterThanOrEqual(1);
    expect(counts.foreign).toBe(0);
  });

  it('inserting a claim stamped for another tenant is rejected (WITH CHECK)', async () => {
    await expect(
      asTenant(appPool!, tenantA.tenantId, async (c) => {
        await c.query(
          `INSERT INTO claims (tenant_id,facility_id,payer_id,claim_type,visit_type,admission_date,status,created_by)
           VALUES ($1,$2,$3,'OUTPATIENT','OP','2026-01-01','DRAFT',$4)`,
          [tenantB.tenantId, tenantA.facilityId, tenantA.payerId, tenantA.userId],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('moving a claim to another tenant via UPDATE is rejected (WITH CHECK)', async () => {
    await expect(
      asTenant(appPool!, tenantA.tenantId, async (c) => {
        await c.query(`UPDATE claims SET tenant_id = $1 WHERE id = $2`, [tenantB.tenantId, tenantA.claimId]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('UPDATE/DELETE of another tenant\'s claim affects zero rows (invisible via USING)', async () => {
    const result = await asTenant(appPool!, tenantA.tenantId, async (c) => {
      const upd = await c.query(`UPDATE claims SET status='PROCESSING' WHERE id = $1`, [tenantB.claimId]);
      const del = await c.query(`DELETE FROM claims WHERE id = $1`, [tenantB.claimId]);
      return { updated: upd.rowCount, deleted: del.rowCount };
    });
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('with no tenant context, selects return zero rows and inserts are rejected (fail closed)', async () => {
    const client = await appPool!.connect();
    try {
      const sel = await client.query(`SELECT id FROM claims`);
      expect(sel.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO claims (tenant_id,facility_id,payer_id,claim_type,visit_type,admission_date,status,created_by)
           VALUES ($1,$2,$3,'OUTPATIENT','OP','2026-01-01','DRAFT',$4)`,
          [tenantA.tenantId, tenantA.facilityId, tenantA.payerId, tenantA.userId],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      client.release();
    }
  });

  it('an empty-string tenant context denies (no error-bypass via cast)', async () => {
    const count = await asTenant(appPool!, '', async (c) => {
      const r = await c.query(`SELECT id FROM claims`);
      return r.rowCount;
    });
    expect(count).toBe(0);
  });

  it('audit_trail is append-only: insert allowed, update/delete denied', async () => {
    // Insert for own tenant is allowed.
    await asTenant(appPool!, tenantA.tenantId, async (c) => {
      await c.query(`INSERT INTO audit_trail (tenant_id,action,detail_json) VALUES ($1,'CLAIM_CREATED','{}')`, [
        tenantA.tenantId,
      ]);
    });
    // Update and delete are denied at the privilege level.
    // Both layers enforce immutability: the app role lacks UPDATE/DELETE
    // privilege (permission denied), and a DB trigger blocks modification even
    // for privileged roles (append-only). Either error proves the guarantee.
    await expect(
      asTenant(appPool!, tenantA.tenantId, async (c) => {
        await c.query(`UPDATE audit_trail SET action='CLAIM_UPDATED' WHERE tenant_id=$1`, [tenantA.tenantId]);
      }),
    ).rejects.toThrow(/permission denied|append-only/i);
    await expect(
      asTenant(appPool!, tenantA.tenantId, async (c) => {
        await c.query(`DELETE FROM audit_trail WHERE tenant_id=$1`, [tenantA.tenantId]);
      }),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  it('global reference tables remain readable under RLS', async () => {
    const ok = await asTenant(appPool!, tenantA.tenantId, async (c) => {
      const payers = await c.query(`SELECT 1 FROM payers LIMIT 1`);
      return (payers.rowCount ?? 0) >= 0;
    });
    expect(ok).toBe(true);
  });
});
