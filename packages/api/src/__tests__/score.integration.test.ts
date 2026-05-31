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
const rulepacksDir = resolve(currentDir, '../../../../rulepacks');
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
    `SELECT tablename FROM pg_tables
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
    'Score Tenant',
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
    [userId, tenantId, facilityId, 'score.officer@example.org', 'Score Officer', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );

  return { tenantId, facilityId, userId, authHeader: createAuthHeader({ tenantId, facilityId, userId }) };
}

function fhirScorePayload(facilityId: string, payerId?: string): Record<string, unknown> {
  return {
    facilityId,
    ...(payerId ? { payerId } : {}),
    claim: {
      resourceType: 'Claim',
      use: 'claim',
      patient: { identifier: { value: 'CR123456789-1' }, display: 'Synthetic Patient' },
      type: { coding: [{ code: 'OUTPATIENT' }] },
      billablePeriod: { start: '2026-03-05' },
      diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { coding: [{ code: 'GB61' }] } }],
      item: [
        {
          sequence: 1,
          productOrService: { coding: [{ code: 'SVC-1' }], text: 'Consultation' },
          quantity: { value: 1 },
          unitPrice: { value: 500 },
        },
      ],
    },
  };
}

integrationDescribe('Scoring endpoint integration (real Postgres)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;
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
        RULEPACK_DIR: rulepacksDir,
      },
    });

    pool = getPool(config);
    await runMigrations(pool);
    const payers = await pool.query<{ id: string; slug: string }>(`SELECT id, slug FROM payers`);
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

  it('scores a FHIR claim, persists claim + audit, and returns a public-safe result', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims/score',
      headers: { authorization: seed.authHeader },
      payload: fhirScorePayload(seed.facilityId),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      data: {
        claimId: string;
        auditId: string;
        decision: string | null;
        riskScore: number;
        riskLevel: string;
        recommendedAction: string;
        flags: Array<{ reasonCode: string; auditorGeneralTypology: string | null }>;
        counts: { failed: number; warning: number; incomplete: number; passed: number };
        payer: { slug: string | null };
      };
    };

    expect(body.data.claimId).toBeTruthy();
    expect(body.data.auditId).toBeTruthy();
    expect(['PASSED', 'FAILED', 'WARNING']).toContain(body.data.decision);
    expect(body.data.riskScore).toBeGreaterThanOrEqual(0);
    expect(body.data.riskScore).toBeLessThanOrEqual(100);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(body.data.riskLevel);
    expect(Array.isArray(body.data.flags)).toBe(true);
    expect(body.data.payer.slug).toBe('sha');
    // Reason codes use the ClaimFlow taxonomy; Auditor-General mapping is not yet supplied.
    for (const flag of body.data.flags) {
      expect(flag.reasonCode.startsWith('CF-')).toBe(true);
      expect(flag.auditorGeneralTypology).toBeNull();
    }

    // Persistence: a claim and an audit session were written, with the payer recorded.
    const session = await pool!.query<{ payer_slug: string | null }>(
      `SELECT payer_slug FROM audit_sessions WHERE id = $1::uuid`,
      [body.data.auditId],
    );
    expect(session.rows[0]?.payer_slug).toBe('sha');

    // Integrity: no detection-rule internals leak into the public response.
    const raw = response.body;
    expect(raw).not.toContain('evidence');
    expect(raw).not.toContain('logicKey');
    expect(raw).not.toContain('logic_key');
    expect(raw).not.toContain('checksum');
    expect(raw).not.toContain('rulepackVersion');
  });

  it('fails closed with problem+json for a COMING_SOON payer', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims/score',
      headers: { authorization: seed.authHeader },
      payload: fhirScorePayload(seed.facilityId, aarPayerId),
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json() as { type: string; title: string; status: number; code: string };
    expect(body.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.type).toContain('claimflow.dev/problems/');
  });

  it('returns problem+json for an invalid FHIR resource', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims/score',
      headers: { authorization: seed.authHeader },
      payload: { facilityId: seed.facilityId, claim: { resourceType: 'Patient' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('replays idempotently with the same Idempotency-Key', async () => {
    const seed = await seedBaseData(pool!);
    const key = randomUUID();

    const first = await app!.inject({
      method: 'POST',
      url: '/v1/claims/score',
      headers: { authorization: seed.authHeader, 'idempotency-key': key },
      payload: fhirScorePayload(seed.facilityId),
    });
    const second = await app!.inject({
      method: 'POST',
      url: '/v1/claims/score',
      headers: { authorization: seed.authHeader, 'idempotency-key': key },
      payload: fhirScorePayload(seed.facilityId),
    });

    expect(first.statusCode).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');

    const firstClaim = (first.json() as { data: { claimId: string } }).data.claimId;
    const secondClaim = (second.json() as { data: { claimId: string } }).data.claimId;
    expect(secondClaim).toBe(firstClaim);
  });
});
