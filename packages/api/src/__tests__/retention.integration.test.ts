import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { getAdminPool, closePool } from '../db/client.js';
import { createRetentionService } from '../services/retention-service.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const ownerUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof ownerUrl === 'string' && ownerUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

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
  await pool.query(
    `TRUNCATE audit_trail, claim_batch_items, claim_batches, idempotency_keys, users, facilities, tenants RESTART IDENTITY CASCADE`,
  );
}

async function seedTenant(
  pool: Pool,
  label: string,
): Promise<{ tenantId: string; userId: string }> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid,$2,$3)`, [
    tenantId,
    `${label} Tenant`,
    `${label}-${tenantId.slice(0, 8)}`,
  ]);
  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, tier_level, county, is_active)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,true)`,
    [facilityId, tenantId, `${label} Facility`, `FID-${label}-${userId.slice(0, 4)}`, 'LEVEL_4', 'Kiambu'],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'admin'::user_role,true,false)`,
    [
      userId,
      tenantId,
      facilityId,
      `${label}@example.org`,
      `${label} Admin`,
      '$2b$12$examplehashforintegrationtests000000000000000000',
    ],
  );
  return { tenantId, userId };
}

integrationDescribe('Retention purge (compliance scaffolding — item 9)', () => {
  let pool: Pool | undefined;

  beforeAll(async () => {
    if (!ownerUrl) {
      throw new Error('Integration database URL missing');
    }
    pool = getAdminPool(
      loadConfig({
        exitOnError: false,
        env: { DATABASE_URL: ownerUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      }),
    );
    await runMigrations(pool);
  });

  beforeEach(async () => {
    if (pool) {
      await truncate(pool);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  function makeService(env: Record<string, string> = {}) {
    const config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: ownerUrl!,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        IDEMPOTENCY_KEY_RETENTION_HOURS: '24',
        CLAIM_BATCH_RETENTION_DAYS: '90',
        ...env,
      },
    });
    const silent: Parameters<typeof createRetentionService>[0]['logger'] = {
      info() {},
      warn() {},
      error() {},
      debug() {},
      trace() {},
      fatal() {},
      child() {
        return silent;
      },
      level: 'silent',
      bindings() {
        return {};
      },
      flush() {},
      isLevelEnabled() {
        return false;
      },
      silent() {},
    } as unknown as Parameters<typeof createRetentionService>[0]['logger'];
    return createRetentionService({ pool: pool!, config, logger: silent });
  }

  it('deletes expired idempotency_keys and writes a per-tenant RETENTION_PURGE_RUN audit_trail row', async () => {
    const a = await seedTenant(pool!, 'a');
    const b = await seedTenant(pool!, 'b');

    // 3 expired keys for tenant a, 1 expired + 1 LIVE for tenant b.
    const past = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const future = new Date(Date.now() + 60 * 60 * 1000); // 1h ahead
    for (const k of ['ka1', 'ka2', 'ka3']) {
      await pool!.query(
        `INSERT INTO idempotency_keys (idempotency_key, tenant_id, response_status, response_body, expires_at)
         VALUES ($1, $2::uuid, 200, '{}', $3)`,
        [k, a.tenantId, past],
      );
    }
    await pool!.query(
      `INSERT INTO idempotency_keys (idempotency_key, tenant_id, response_status, response_body, expires_at)
       VALUES ($1, $2::uuid, 200, '{}', $3)`,
      ['kb1', b.tenantId, past],
    );
    await pool!.query(
      `INSERT INTO idempotency_keys (idempotency_key, tenant_id, response_status, response_body, expires_at)
       VALUES ($1, $2::uuid, 200, '{}', $3)`,
      ['kb-live', b.tenantId, future],
    );

    const result = await makeService().runPurgeCycle();

    expect(result.totalIdempotencyKeysDeleted).toBe(4);
    expect(result.perTenant).toHaveLength(2);
    const aSummary = result.perTenant.find((p) => p.tenantId === a.tenantId);
    const bSummary = result.perTenant.find((p) => p.tenantId === b.tenantId);
    expect(aSummary?.idempotencyKeysDeleted).toBe(3);
    expect(bSummary?.idempotencyKeysDeleted).toBe(1);

    // Live key was NOT deleted.
    const live = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM idempotency_keys WHERE idempotency_key = 'kb-live'`,
    );
    expect(live.rows[0]!.n).toBe('1');

    // One immutable audit_trail row per tenant, action = RETENTION_PURGE_RUN.
    const trail = await pool!.query<{
      tenant_id: string;
      action: string;
      detail_json: { deleted?: { idempotencyKeys?: number } };
    }>(
      `SELECT tenant_id, action::text, detail_json FROM audit_trail
        WHERE action = 'RETENTION_PURGE_RUN' ORDER BY tenant_id`,
    );
    expect(trail.rowCount).toBe(2);
    for (const row of trail.rows) {
      const deleted = row.detail_json.deleted?.idempotencyKeys;
      expect(deleted).toBeGreaterThan(0);
    }
  });

  it('deletes terminal claim_batches past retention and cascades items', async () => {
    const a = await seedTenant(pool!, 'a');
    // Old completed batch (94 days ago) → should be purged.
    const old = randomUUID();
    const oldDate = new Date(Date.now() - 94 * 24 * 60 * 60 * 1000);
    await pool!.query(
      `INSERT INTO claim_batches (id, tenant_id, status, total_claims, processed_count, created_by, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'COMPLETED', 2, 2, $3::uuid, $4, $4)`,
      [old, a.tenantId, a.userId, oldDate],
    );
    for (let i = 0; i < 2; i += 1) {
      await pool!.query(
        `INSERT INTO claim_batch_items (batch_id, tenant_id, item_index, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'SCORED', $4, $4)`,
        [old, a.tenantId, i, oldDate],
      );
    }
    // Recent batch (1 day ago) → should be kept.
    const recent = randomUUID();
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    await pool!.query(
      `INSERT INTO claim_batches (id, tenant_id, status, total_claims, processed_count, created_by, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'COMPLETED', 1, 1, $3::uuid, $4, $4)`,
      [recent, a.tenantId, a.userId, recentDate],
    );
    // Non-terminal (still PROCESSING) old batch → should NOT be purged.
    const stuck = randomUUID();
    await pool!.query(
      `INSERT INTO claim_batches (id, tenant_id, status, total_claims, processed_count, created_by, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'PROCESSING', 1, 0, $3::uuid, $4, $4)`,
      [stuck, a.tenantId, a.userId, oldDate],
    );

    const result = await makeService().runPurgeCycle();

    expect(result.totalClaimBatchesDeleted).toBe(1);
    expect(result.totalClaimBatchItemsDeleted).toBe(2);

    const remaining = await pool!.query<{ id: string; status: string }>(
      `SELECT id::text, status FROM claim_batches ORDER BY status`,
    );
    expect(remaining.rowCount).toBe(2);
    expect(remaining.rows.map((r) => r.status).sort()).toEqual(['COMPLETED', 'PROCESSING']);

    // The cascaded items for the old batch are gone.
    const items = await pool!.query<{ n: string }>(`SELECT count(*)::text AS n FROM claim_batch_items`);
    expect(items.rows[0]!.n).toBe('0');
  });

  it('purges nothing AND writes no audit row when there is nothing to delete (no-op idempotency)', async () => {
    await seedTenant(pool!, 'a');
    const r1 = await makeService().runPurgeCycle();
    const r2 = await makeService().runPurgeCycle();
    expect(r1.perTenant).toHaveLength(0);
    expect(r2.perTenant).toHaveLength(0);
    const trail = await pool!.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_trail WHERE action = 'RETENTION_PURGE_RUN'`,
    );
    expect(trail.rows[0]!.n).toBe('0');
  });
});
