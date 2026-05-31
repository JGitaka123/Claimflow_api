import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

function createAuthHeader(context: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: context.userId,
      tenantId: context.tenantId,
      facilityId: context.facilityId,
      role: 'claims_officer',
    }),
  ).toString('base64url');

  return `Bearer ${header}.${payload}.signature`;
}

async function runMigrations(pool: Pool): Promise<void> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(currentDir, '../../../../migrations');
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const client = await pool.connect();
  const migrationLockKey = 951337;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockKey]);

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
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockKey]);
    } catch {
      // ignore
    }

    client.release();
  }
}

async function truncatePublicTables(pool: Pool): Promise<void> {
  const tableRows = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('schema_migrations', 'payers', 'icd_codes', 'sha_service_codes')`,
  );

  if (tableRows.rows.length === 0) {
    return;
  }

  const tableList = tableRows.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  authHeader: string;
}

async function seedBaseData(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();

  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, $2, $3)`, [
    tenantId,
    'Payer Test Tenant',
    `tenant-${tenantId.slice(0, 8)}`,
  ]);

  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, sha_provider_id, tier_level, county, is_active)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, true)`,
    [facilityId, tenantId, 'Mary Help Mission', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );

  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'claims_officer'::user_role, true, false)`,
    [userId, tenantId, facilityId, 'payer.officer@example.org', 'Payer Officer', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );

  return { tenantId, facilityId, userId, authHeader: createAuthHeader({ tenantId, facilityId, userId }) };
}

function claimPayload(facilityId: string, suffix: string, payerId?: string): Record<string, unknown> {
  return {
    facilityId,
    ...(payerId ? { payerId } : {}),
    claimType: 'OUTPATIENT',
    visitType: 'OP',
    patientShaId: `CR12345678${suffix}-1`,
    admissionDate: '2026-03-05',
    primaryDiagnosisCode: `D${suffix}`,
    lines: [{ shaServiceCode: `SVC-${suffix}`, description: 'Consultation', quantity: 1, unitPrice: 500 }],
  };
}

integrationDescribe('Payer threading integration (real Postgres)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;
  let shaPayerId: string;
  let aarPayerId: string;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }

    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: integrationDatabaseUrl,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '1000',
      },
    });

    pool = getPool(config);
    await runMigrations(pool);

    const payers = await pool.query<{ id: string; slug: string }>(`SELECT id, slug FROM payers`);
    shaPayerId = payers.rows.find((row) => row.slug === 'sha')?.id ?? '';
    aarPayerId = payers.rows.find((row) => row.slug === 'aar')?.id ?? '';

    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) {
      throw new Error('Integration pool not initialized');
    }

    await truncatePublicTables(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    await closePool();
  });

  it('defaults a claim with no payer to the SHA payer', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: claimPayload(seed.facilityId, 'A'),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      data: { claim: { id: string; payerId: string; payerSlug: string; payerName: string } };
    };
    expect(body.data.claim.payerId).toBe(shaPayerId);
    expect(body.data.claim.payerSlug).toBe('sha');
    expect(body.data.claim.payerName).toBe('Social Health Authority');

    const persisted = await pool!.query<{ payer_id: string }>(
      `SELECT payer_id FROM claims WHERE id = $1::uuid`,
      [body.data.claim.id],
    );
    expect(persisted.rows[0]?.payer_id).toBe(shaPayerId);
  });

  it('accepts an explicit ACTIVE payer id', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: claimPayload(seed.facilityId, 'B', shaPayerId),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { data: { claim: { payerSlug: string } } };
    expect(body.data.claim.payerSlug).toBe('sha');
  });

  it('rejects a COMING_SOON payer with 400 VALIDATION_ERROR (fail closed)', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: claimPayload(seed.facilityId, 'C', aarPayerId),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { errors: Array<{ code: string; field?: string }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.errors[0]?.field).toBe('payerId');
  });

  it('rejects an unknown payer id with 400 VALIDATION_ERROR', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: claimPayload(seed.facilityId, 'D', randomUUID()),
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('enforces NOT NULL on claims.payer_id', async () => {
    const column = await pool!.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_name = 'claims' AND column_name = 'payer_id'`,
    );

    expect(column.rows[0]?.is_nullable).toBe('NO');
  });

  it('returns payer fields on claim detail reads', async () => {
    const seed = await seedBaseData(pool!);

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: claimPayload(seed.facilityId, 'E'),
    });
    const claimId = (created.json() as { data: { claim: { id: string } } }).data.claim.id;

    const detail = await app!.inject({
      method: 'GET',
      url: `/v1/claims/${claimId}`,
      headers: { authorization: seed.authHeader },
    });

    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { data: { claim: { payerSlug: string; payerName: string } } };
    expect(body.data.claim.payerSlug).toBe('sha');
    expect(body.data.claim.payerName).toBe('Social Health Authority');
  });
});
