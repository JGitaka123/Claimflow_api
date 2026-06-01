import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PreauthorizationStatus } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getAdminPool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  authHeader: string;
}

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

  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  const migrationLockKey = 951337;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockKey]);

    for (const file of files) {
      const sql = await readFile(resolve(migrationsDir, file), 'utf8');
      await client.query(sql);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockKey]);
    } catch {
      // ignore unlock errors
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

async function seedBaseData(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();

  await pool.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3)`,
    [tenantId, 'Preauth Tenant', `tenant-${tenantId.slice(0, 8)}`],
  );

  await pool.query(
    `INSERT INTO facilities (
        id,
        tenant_id,
        name,
        sha_facility_code,
        sha_provider_id,
        tier_level,
        county,
        is_active
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        $5,
        $6,
        $7,
        true
      )`,
    [facilityId, tenantId, 'Mary Help Mission', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );

  await pool.query(
    `INSERT INTO users (
        id,
        tenant_id,
        facility_id,
        email,
        display_name,
        password_hash,
        role,
        is_active,
        must_change_password
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4,
        $5,
        $6,
        'claims_officer'::user_role,
        true,
        false
      )`,
    [
      userId,
      tenantId,
      facilityId,
      'preauth.officer@example.org',
      'Preauth Officer',
      '$2b$12$examplehashforintegrationtests000000000000000000',
    ],
  );

  return {
    tenantId,
    facilityId,
    userId,
    authHeader: createAuthHeader({ tenantId, facilityId, userId }),
  };
}

function createClaimPayload(facilityId: string, preauthNumber: string, serviceCode: string, patientShaId = 'CR123456789-1') {
  return {
    facilityId,
    claimType: 'OUTPATIENT',
    visitType: 'OP',
    patientShaId,
    patientName: 'Preauth Patient',
    patientNationalId: 'ID-PA-1',
    hmisRef: `HMIS-${serviceCode}`,
    admissionDate: '2026-03-10',
    primaryDiagnosisCode: 'D100',
    shaBenefitPackage: 'SHA-BASE',
    preauthNumber,
    lines: [
      {
        shaServiceCode: serviceCode,
        description: 'Preauthorized service',
        quantity: 1,
        unitPrice: 1500,
      },
    ],
  };
}

integrationDescribe('Preauthorization integration', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;

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

    pool = getAdminPool(config);
    await pool.query('SELECT 1');
    await runMigrations(pool);

    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) {
      throw new Error('Pool not initialized');
    }

    await truncatePublicTables(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    await closePool();
  });

  it('upserts preauthorization and persists service codes', async () => {
    const seed = await seedBaseData(pool!);

    const createResponse = await app!.inject({
      method: 'POST',
      url: '/v1/preauthorizations',
      headers: {
        authorization: seed.authHeader,
      },
      payload: {
        preauthNumber: 'PA-TEST-1001',
        patientShaId: 'CR123456789-1',
        validFrom: '2026-03-01',
        validTo: '2026-03-31',
        source: 'SHA_PORTAL',
        serviceCodes: [
          { shaServiceCode: 'SVC-100', quantityAuthorized: 2, maxAmountKes: 5000 },
          { shaServiceCode: 'svc-200' },
        ],
      },
    });

    expect(createResponse.statusCode).toBe(201);

    const createBody = createResponse.json() as {
      data: {
        preauthNumber: string;
        serviceCodes: Array<{ shaServiceCode: string }>;
        status: PreauthorizationStatus;
      };
    };

    expect(createBody.data.preauthNumber).toBe('PA-TEST-1001');
    expect(createBody.data.status).toBe(PreauthorizationStatus.ACTIVE);
    expect(createBody.data.serviceCodes.map((entry) => entry.shaServiceCode)).toEqual(['SVC-100', 'SVC-200']);

    const updateResponse = await app!.inject({
      method: 'POST',
      url: '/v1/preauthorizations',
      headers: {
        authorization: seed.authHeader,
      },
      payload: {
        preauthNumber: 'PA-TEST-1001',
        patientShaId: 'CR123456789-1',
        status: 'USED',
        validFrom: '2026-03-01',
        validTo: '2026-03-31',
        source: 'MANUAL_ENTRY',
        serviceCodes: [
          { shaServiceCode: 'SVC-100' },
        ],
      },
    });

    expect(updateResponse.statusCode).toBe(200);

    const updateBody = updateResponse.json() as {
      data: {
        status: PreauthorizationStatus;
        serviceCodes: Array<{ shaServiceCode: string }>;
      };
    };

    expect(updateBody.data.status).toBe(PreauthorizationStatus.USED);
    expect(updateBody.data.serviceCodes.map((entry) => entry.shaServiceCode)).toEqual(['SVC-100']);

    const actionCounts = await pool!.query<{ action: string; count: string }>(
      `SELECT action::text AS action, COUNT(*)::text AS count
         FROM audit_trail
        WHERE tenant_id = $1::uuid
          AND action IN ('PREAUTH_REGISTERED'::audit_action, 'PREAUTH_UPDATED'::audit_action)
        GROUP BY action`,
      [seed.tenantId],
    );

    const countByAction = Object.fromEntries(
      actionCounts.rows.map((row) => [row.action, Number.parseInt(row.count, 10)]),
    );

    expect(countByAction.PREAUTH_REGISTERED ?? 0).toBe(1);
    expect(countByAction.PREAUTH_UPDATED ?? 0).toBe(1);
  });

  it('fetches preauthorization by number', async () => {
    const seed = await seedBaseData(pool!);

    await app!.inject({
      method: 'POST',
      url: '/v1/preauthorizations',
      headers: {
        authorization: seed.authHeader,
      },
      payload: {
        preauthNumber: 'PA-TEST-2002',
        patientShaId: 'CR123456789-1',
        validTo: '2026-04-30',
        serviceCodes: [
          { shaServiceCode: 'SVC-200' },
        ],
      },
    });

    const response = await app!.inject({
      method: 'GET',
      url: '/v1/preauthorizations/PA-TEST-2002',
      headers: {
        authorization: seed.authHeader,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      data: {
        preauthNumber: string;
        patientShaId: string;
        serviceCodes: Array<{ shaServiceCode: string }>;
      };
    };

    expect(body.data.preauthNumber).toBe('PA-TEST-2002');
    expect(body.data.patientShaId).toBe('CR123456789-1');
    expect(body.data.serviceCodes).toHaveLength(1);
    expect(body.data.serviceCodes[0]?.shaServiceCode).toBe('SVC-200');
  });

  it('validates claim preauthorization coverage and identity', async () => {
    const seed = await seedBaseData(pool!);

    await app!.inject({
      method: 'POST',
      url: '/v1/preauthorizations',
      headers: {
        authorization: seed.authHeader,
      },
      payload: {
        preauthNumber: 'PA-TEST-3003',
        patientShaId: 'CR123456789-1',
        validFrom: '2026-03-01',
        validTo: '2026-03-31',
        serviceCodes: [
          { shaServiceCode: 'SVC-300' },
        ],
      },
    });

    const claimCreated = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: {
        authorization: seed.authHeader,
      },
      payload: createClaimPayload(seed.facilityId, 'PA-TEST-3003', 'SVC-300', 'CR123456789-1'),
    });

    expect(claimCreated.statusCode).toBe(201);

    const claimId = (claimCreated.json() as { data: { claim: { id: string } } }).data.claim.id;

    const validationResponse = await app!.inject({
      method: 'GET',
      url: `/v1/claims/${claimId}/preauthorization/validation`,
      headers: {
        authorization: seed.authHeader,
      },
    });

    expect(validationResponse.statusCode).toBe(200);

    const validationBody = validationResponse.json() as {
      data: {
        recordFound: boolean;
        overallValid: boolean;
        reasons: string[];
        missingServiceCodes: string[];
      };
    };

    expect(validationBody.data.recordFound).toBe(true);
    expect(validationBody.data.overallValid).toBe(true);
    expect(validationBody.data.reasons).toEqual([]);
    expect(validationBody.data.missingServiceCodes).toEqual([]);
  });

  it('returns detailed mismatch reasons for invalid preauthorization links', async () => {
    const seed = await seedBaseData(pool!);

    await app!.inject({
      method: 'POST',
      url: '/v1/preauthorizations',
      headers: {
        authorization: seed.authHeader,
      },
      payload: {
        preauthNumber: 'PA-TEST-4004',
        patientShaId: 'CR999999999-9',
        status: 'ACTIVE',
        validFrom: '2026-02-01',
        validTo: '2026-03-05',
        serviceCodes: [
          { shaServiceCode: 'SVC-401' },
        ],
      },
    });

    const claimCreated = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: {
        authorization: seed.authHeader,
      },
      payload: createClaimPayload(seed.facilityId, 'PA-TEST-4004', 'SVC-499', 'CR123456789-1'),
    });

    expect(claimCreated.statusCode).toBe(201);

    const claimId = (claimCreated.json() as { data: { claim: { id: string } } }).data.claim.id;

    const validationResponse = await app!.inject({
      method: 'GET',
      url: `/v1/claims/${claimId}/preauthorization/validation`,
      headers: {
        authorization: seed.authHeader,
      },
    });

    expect(validationResponse.statusCode).toBe(200);

    const validationBody = validationResponse.json() as {
      data: {
        overallValid: boolean;
        reasons: string[];
        missingServiceCodes: string[];
      };
    };

    expect(validationBody.data.overallValid).toBe(false);
    expect(validationBody.data.reasons).toContain('patient_mismatch');
    expect(validationBody.data.reasons).toContain('preauth_expired');
    expect(validationBody.data.reasons).toContain('missing_service_coverage');
    expect(validationBody.data.missingServiceCodes).toEqual(['SVC-499']);
  });
});
