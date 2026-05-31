import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
import { buildServer } from '../server.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

function adminJwt(c: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: c.userId, tenantId: c.tenantId, facilityId: c.facilityId, role: 'admin' }),
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
    'Key Tenant',
    `tenant-${tenantId.slice(0, 8)}`,
  ]);
  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, sha_provider_id, tier_level, county, is_active)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,true)`,
    [facilityId, tenantId, 'Key Facility', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'admin'::user_role,true,false)`,
    [userId, tenantId, facilityId, `key.admin+${userId.slice(0, 8)}@example.org`, 'Key Admin', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );
  return { tenantId, facilityId, userId, jwt: adminJwt({ tenantId, facilityId, userId }) };
}

async function createKey(app: FastifyInstance, s: SeedContext, scopes: string[]): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { authorization: s.jwt },
    payload: { name: 'integration key', scopes },
  });
  return (response.json() as { data: { key: string } }).data.key;
}

const claimPayload = (facilityId: string, suffix: string): Record<string, unknown> => ({
  facilityId,
  claimType: 'OUTPATIENT',
  visitType: 'OP',
  patientShaId: `CR12345678${suffix}-1`,
  admissionDate: '2026-03-05',
  primaryDiagnosisCode: `D${suffix}`,
  lines: [{ shaServiceCode: `SVC-${suffix}`, description: 'Consult', quantity: 1, unitPrice: 500 }],
});

integrationDescribe('API keys integration (real Postgres)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }
    config = loadConfig({
      exitOnError: false,
      env: { DATABASE_URL: integrationDatabaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_RPM: '1000' },
    });
    pool = getPool(config);
    await runMigrations(pool);
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

  it('creates a key (secret once) and hides the secret on list', async () => {
    const s = await seed(pool!);
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: s.jwt },
      payload: { name: 'EMR integration', scopes: ['claim:create', 'audit:trigger'] },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json() as { data: { id: string; key?: string; scopes: string[] } };
    expect(body.data.key?.startsWith('cf_')).toBe(true);
    expect(body.data.scopes).toEqual(['claim:create', 'audit:trigger']);

    const list = await app!.inject({ method: 'GET', url: '/v1/api-keys', headers: { authorization: s.jwt } });
    const listBody = list.json() as { data: Array<{ key?: string; keyPrefix: string }> };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.key).toBeUndefined();
    expect(listBody.data[0]?.keyPrefix).toBeTruthy();
  });

  it('authenticates a request and enforces scopes', async () => {
    const s = await seed(pool!);
    const key = await createKey(app!, s, ['claim:create']);

    // In-scope: claim:create -> POST /v1/claims succeeds with the key.
    const allowed = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { 'x-api-key': key },
      payload: claimPayload(s.facilityId, 'K'),
    });
    expect(allowed.statusCode).toBe(201);

    // Out-of-scope: the key lacks system:settings -> listing keys is forbidden.
    const forbidden = await app!.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { 'x-api-key': key },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('accepts the key via Authorization: Bearer as well', async () => {
    const s = await seed(pool!);
    const key = await createKey(app!, s, ['claim:create']);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: `Bearer ${key}` },
      payload: claimPayload(s.facilityId, 'B'),
    });
    expect(response.statusCode).toBe(201);
  });

  it('rejects a revoked key', async () => {
    const s = await seed(pool!);
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: s.jwt },
      payload: { name: 'temp', scopes: ['claim:create'] },
    });
    const { id, key } = (created.json() as { data: { id: string; key: string } }).data;

    const revoked = await app!.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${id}`,
      headers: { authorization: s.jwt },
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { 'x-api-key': key },
      payload: claimPayload(s.facilityId, 'R'),
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('rejects an expired key and an unknown key', async () => {
    const s = await seed(pool!);
    const key = await createKey(app!, s, ['claim:create']);

    await pool!.query(`UPDATE api_keys SET expires_at = now() - INTERVAL '1 hour' WHERE tenant_id = $1::uuid`, [
      s.tenantId,
    ]);

    const expired = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { 'x-api-key': key },
      payload: claimPayload(s.facilityId, 'E'),
    });
    expect(expired.statusCode).toBe(401);

    const unknown = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { 'x-api-key': 'cf_deadbeef_unknownsecret' },
      payload: claimPayload(s.facilityId, 'U'),
    });
    expect(unknown.statusCode).toBe(401);
  });
});
