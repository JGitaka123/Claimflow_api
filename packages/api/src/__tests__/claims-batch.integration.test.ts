import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getAdminPool, closePool } from '../db/client.js';
import { buildServer } from '../server.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rulepacksDir = resolve(currentDir, '../../../../rulepacks');
const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

function authHeader(c: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: c.userId, tenantId: c.tenantId, facilityId: c.facilityId, role: 'claims_officer' }),
  ).toString('base64url');
  return `Bearer ${header}.${payload}.signature`;
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
  if (rows.rows.length === 0) return;
  await pool.query(`TRUNCATE TABLE ${rows.rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  authHeader: string;
}

async function seed(pool: Pool, slug = 'b'): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid,$2,$3)`, [
    tenantId,
    `Batch Tenant ${slug}`,
    `tenant-${slug}-${tenantId.slice(0, 8)}`,
  ]);
  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, sha_provider_id, tier_level, county, is_active)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,true)`,
    [facilityId, tenantId, 'Mary Help Mission', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'claims_officer'::user_role,true,false)`,
    [userId, tenantId, facilityId, `batch.${slug}+${userId.slice(0, 8)}@example.org`, 'Batch Officer', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );
  return { tenantId, facilityId, userId, authHeader: authHeader({ tenantId, facilityId, userId }) };
}

function fhirClaim(facilityId: string, suffix: string): Record<string, unknown> {
  return {
    facilityId,
    claim: {
      resourceType: 'Claim',
      use: 'claim',
      patient: { identifier: { value: `CR12345678${suffix}-1` }, display: 'Synthetic Patient' },
      type: { coding: [{ code: 'OUTPATIENT' }] },
      billablePeriod: { start: '2026-03-05' },
      item: [{ sequence: 1, productOrService: { coding: [{ code: `SVC-${suffix}` }], text: 'Consult' }, quantity: { value: 1 }, unitPrice: { value: 500 } }],
    },
  };
}

async function waitForBatch(app: FastifyInstance, auth: string, batchId: string): Promise<{ status: string; processedCount: number; totalClaims: number; items: Array<{ index: number; status: string; claimId: string | null; score: unknown; errorCode: string | null }> }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: 'GET', url: `/v1/claims/batch/${batchId}`, headers: { authorization: auth } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { status: string; processedCount: number; totalClaims: number; items: Array<{ index: number; status: string; claimId: string | null; score: unknown; errorCode: string | null }> } };
    if (['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'].includes(body.data.status)) {
      return body.data;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for batch ${batchId}`);
}

integrationDescribe('Async claim batch (pg-boss, real Postgres)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }
    config = loadConfig({
      exitOnError: false,
      env: { DATABASE_URL: integrationDatabaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_RPM: '100000', RULEPACK_DIR: rulepacksDir },
    });
    pool = getAdminPool(config);
    await runMigrations(pool);
    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) throw new Error('pool not initialized');
    await truncate(pool);
  });

  afterAll(async () => {
    if (app) await app.close();
    await closePool();
  });

  it('accepts a batch (202 + batch id) and scores each claim asynchronously', { timeout: 30_000 }, async () => {
    const s = await seed(pool!);
    const res = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: s.authHeader },
      payload: { claims: [fhirClaim(s.facilityId, '1'), fhirClaim(s.facilityId, '2')] },
    });
    expect(res.statusCode).toBe(202);
    const accepted = res.json() as { data: { batchId: string; status: string; totalClaims: number } };
    expect(accepted.data.status).toBe('QUEUED');
    expect(accepted.data.totalClaims).toBe(2);

    const final = await waitForBatch(app!, s.authHeader, accepted.data.batchId);
    expect(final.status).toBe('COMPLETED');
    expect(final.processedCount).toBe(2);
    expect(final.items).toHaveLength(2);
    for (const item of final.items) {
      expect(item.status).toBe('SCORED');
      expect(item.claimId).toBeTruthy();
      expect(item.score).toBeTruthy();
    }
  });

  it('isolates a malformed claim to its own item (partial failure)', { timeout: 30_000 }, async () => {
    const s = await seed(pool!);
    // Item 1 is valid; item 0 references an unknown payer -> fails that item only.
    const bad = { ...fhirClaim(s.facilityId, '9'), payerId: randomUUID() };
    const res = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: s.authHeader },
      payload: { claims: [bad, fhirClaim(s.facilityId, '8')] },
    });
    expect(res.statusCode).toBe(202);
    const batchId = (res.json() as { data: { batchId: string } }).data.batchId;

    const final = await waitForBatch(app!, s.authHeader, batchId);
    expect(final.status).toBe('COMPLETED_WITH_ERRORS');
    const byIndex = Object.fromEntries(final.items.map((i) => [i.index, i]));
    expect(byIndex[0]?.status).toBe('FAILED');
    expect(byIndex[0]?.errorCode).toBeTruthy();
    expect(byIndex[1]?.status).toBe('SCORED');
  });

  it('per-item score carries no rule internals', { timeout: 30_000 }, async () => {
    const s = await seed(pool!);
    const res = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: s.authHeader },
      payload: { claims: [fhirClaim(s.facilityId, '3')] },
    });
    const batchId = (res.json() as { data: { batchId: string } }).data.batchId;
    const final = await waitForBatch(app!, s.authHeader, batchId);
    const str = JSON.stringify(final);
    for (const internal of ['deterministicScore', 'mlQualityScore', 'fixReportMd', 'evidence', 'remediation']) {
      expect(str, `batch item must not leak ${internal}`).not.toContain(internal);
    }
  });

  it('is idempotent on Idempotency-Key (same batch id, no second job)', async () => {
    const s = await seed(pool!);
    const key = `batch-${randomUUID()}`;
    const first = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: s.authHeader, 'idempotency-key': key },
      payload: { claims: [fhirClaim(s.facilityId, '4')] },
    });
    const second = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: s.authHeader, 'idempotency-key': key },
      payload: { claims: [fhirClaim(s.facilityId, '4')] },
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    const id1 = (first.json() as { data: { batchId: string } }).data.batchId;
    const id2 = (second.json() as { data: { batchId: string } }).data.batchId;
    expect(id2).toBe(id1);
    const batches = await pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM claim_batches WHERE tenant_id = $1::uuid`,
      [s.tenantId],
    );
    expect(batches.rows[0]?.count).toBe('1');
  });

  it('rejects an over-size batch (400)', async () => {
    const s = await seed(pool!);
    const claims = Array.from({ length: 201 }, (_, i) => fhirClaim(s.facilityId, String(i)));
    const res = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: s.authHeader },
      payload: { claims },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces tenant isolation on batch status (cross-tenant -> 404)', async () => {
    const a = await seed(pool!, 'a');
    const b = await seed(pool!, 'c');
    const res = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: a.authHeader },
      payload: { claims: [fhirClaim(a.facilityId, '5')] },
    });
    const batchId = (res.json() as { data: { batchId: string } }).data.batchId;
    const cross = await app!.inject({ method: 'GET', url: `/v1/claims/batch/${batchId}`, headers: { authorization: b.authHeader } });
    expect(cross.statusCode).toBe(404);
  });

  it('counts each scored claim toward usage metering (route class batch)', { timeout: 30_000 }, async () => {
    const s = await seed(pool!);
    const res = await app!.inject({
      method: 'POST',
      url: '/v1/claims/batch',
      headers: { authorization: s.authHeader },
      payload: { claims: [fhirClaim(s.facilityId, '6'), fhirClaim(s.facilityId, '7')] },
    });
    const batchId = (res.json() as { data: { batchId: string } }).data.batchId;
    await waitForBatch(app!, s.authHeader, batchId);
    // Sum across windows (the two scores could straddle a 1-minute boundary).
    const counter = await pool!.query<{ total: string }>(
      `SELECT COALESCE(SUM(request_count),0)::text AS total
         FROM usage_counters WHERE tenant_id = $1::uuid AND route_class = 'batch'`,
      [s.tenantId],
    );
    expect(Number(counter.rows[0]?.total)).toBe(2);
  });
});
