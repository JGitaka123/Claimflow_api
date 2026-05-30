import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClaimStatus, ErrorCode } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
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
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
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

      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${file}`, {
          cause: error as Error,
        });
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockKey]);
    } catch {
      // ignore unlock failures during teardown
    }

    client.release();
  }
}

async function truncatePublicTables(pool: Pool): Promise<void> {
  const tableRows = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> 'schema_migrations'`,
  );

  if (tableRows.rows.length === 0) {
    return;
  }

  const tableList = tableRows.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool!.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

async function seedBaseData(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();

  await pool!.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3)`,
    [tenantId, 'Integration Tenant', `tenant-${tenantId.slice(0, 8)}`],
  );

  await pool!.query(
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

  await pool!.query(
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
      'claims.officer@example.org',
      'Claims Officer',
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

function createClaimPayload(facilityId: string, suffix: string): Record<string, unknown> {
  return {
    facilityId,
    claimType: 'OUTPATIENT',
    visitType: 'OP',
    patientShaId: `CR12345678${suffix}-1`,
    patientName: `Patient ${suffix}`,
    patientNationalId: `ID-${suffix}`,
    hmisRef: `HMIS-${suffix}`,
    admissionDate: '2026-03-05',
    primaryDiagnosisCode: `D${suffix}`,
    shaBenefitPackage: 'SHA-BASE',
    lines: [
      {
        shaServiceCode: `SVC-${suffix}`,
        description: 'Consultation',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  };
}

integrationDescribe('Claims routes integration (real Postgres)', () => {
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

    pool = getPool(config);

    try {
      await pool!.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Unable to connect to integration Postgres at ${integrationDatabaseUrl ?? "unknown"}. Start Postgres and retry.`,
        { cause: error as Error },
      );
    }

    await runMigrations(pool!);

    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) {
      throw new Error('Integration pool was not initialized');
    }

    await truncatePublicTables(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    await closePool();
  });

  it('Create claim returns 201 with persisted claim and lines', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: {
        authorization: seed.authHeader,
      },
      payload: createClaimPayload(seed.facilityId, '1'),
    });

    expect(response.statusCode).toBe(201);

    const payload = response.json() as {
      data: { claim: { id: string; status: ClaimStatus }; lines: Array<{ lineNumber: number }> };
    };

    expect(payload.data.claim.status).toBe(ClaimStatus.DRAFT);
    expect(payload.data.lines).toHaveLength(1);
    expect(payload.data.lines[0].lineNumber).toBe(1);

    const claimRow = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM claims');
    const lineRow = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM claim_lines');

    expect(Number.parseInt(claimRow.rows[0]?.count ?? '0', 10)).toBe(1);
    expect(Number.parseInt(lineRow.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('Create duplicate claim returns 409 DUPLICATE_CLAIM', async () => {
    const seed = await seedBaseData(pool!);
    const payload = createClaimPayload(seed.facilityId, '2');

    const first = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload,
    });

    expect(first.statusCode).toBe(201);

    const duplicate = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload,
    });

    expect(duplicate.statusCode).toBe(409);

    const duplicateBody = duplicate.json() as { errors: Array<{ code: ErrorCode }> };
    expect(duplicateBody.errors[0]?.code).toBe(ErrorCode.DUPLICATE_CLAIM);
  });

  it('POST idempotency returns cached response on replay', async () => {
    const seed = await seedBaseData(pool!);
    const payload = createClaimPayload(seed.facilityId, '3');

    const first = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: {
        authorization: seed.authHeader,
        'idempotency-key': 'idem-create-1',
      },
      payload,
    });

    const second = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: {
        authorization: seed.authHeader,
        'idempotency-key': 'idem-create-1',
      },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    const firstBody = first.json() as Record<string, unknown>;
    const secondBody = second.json() as Record<string, unknown>;
    expect(secondBody).toEqual(firstBody);
  });

  it('List claims supports filters and cursor pagination', async () => {
    const seed = await seedBaseData(pool!);

    const createOne = async (suffix: string): Promise<string> => {
      const created = await app!.inject({
        method: 'POST',
        url: '/v1/claims',
        headers: { authorization: seed.authHeader },
        payload: createClaimPayload(seed.facilityId, suffix),
      });

      const body = created.json() as { data: { claim: { id: string } } };
      return body.data.claim.id;
    };

    const claimA = await createOne('4');
    const claimB = await createOne('5');
    await createOne('6');

    await pool!.query(`UPDATE claims SET status = 'FAILED'::claim_status WHERE id = $1::uuid`, [claimB]);

    const firstPage = await app!.inject({
      method: 'GET',
      url: '/v1/claims?limit=2&sortBy=createdAt&sortOrder=asc',
      headers: { authorization: seed.authHeader },
    });

    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json() as {
      data: Array<{ id: string }>;
      meta: { hasMore: boolean; cursor: string | null };
    };

    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.meta.hasMore).toBe(true);
    expect(typeof firstBody.meta.cursor).toBe('string');

    const secondPage = await app!.inject({
      method: 'GET',
      url: `/v1/claims?limit=2&sortBy=createdAt&sortOrder=asc&cursor=${encodeURIComponent(firstBody.meta.cursor ?? '')}`,
      headers: { authorization: seed.authHeader },
    });

    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json() as { data: Array<{ id: string }> };
    expect(secondBody.data.length).toBeGreaterThanOrEqual(1);

    const filtered = await app!.inject({
      method: 'GET',
      url: '/v1/claims?status=FAILED',
      headers: { authorization: seed.authHeader },
    });

    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { data: Array<{ id: string; status: ClaimStatus }> };
    expect(filteredBody.data).toHaveLength(1);
    expect(filteredBody.data[0]?.id).toBe(claimB);
    expect(filteredBody.data[0]?.status).toBe(ClaimStatus.FAILED);
    expect(filteredBody.data.some((claim) => claim.id === claimA)).toBe(false);
  });

  it('Get claim by ID returns claim with lines, documents, and latest audit session', async () => {
    const seed = await seedBaseData(pool!);

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: createClaimPayload(seed.facilityId, '7'),
    });

    const createdBody = created.json() as { data: { claim: { id: string } } };
    const claimId = createdBody.data.claim.id;

    await pool!.query(
      `INSERT INTO documents (
          id,
          claim_id,
          doc_type,
          processing_route,
          mime_type,
          original_filename,
          page_count,
          file_size_bytes,
          storage_path,
          sha256,
          processing_status,
          uploaded_by
        ) VALUES (
          $1::uuid,
          $2::uuid,
          'PHYSICIAN_NOTES'::doc_type,
          'FULL_OCR_EXTRACT'::doc_processing_route,
          'application/pdf',
          'notes.pdf',
          1,
          1024,
          '/tmp/notes.pdf',
          'abc123',
          'COMPLETED'::doc_processing_status,
          $3::uuid
        )`,
      [randomUUID(), claimId, seed.userId],
    );

    await pool!.query(
      `INSERT INTO audit_sessions (
          id,
          claim_id,
          user_id,
          rulepack_version,
          rulepack_checksum,
          decision,
          total_rules,
          passed_count,
          failed_count,
          warning_count,
          incomplete_count,
          skipped_count,
          started_at,
          completed_at
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          '1.0.0',
          'checksum',
          'WARNING'::audit_decision,
          10,
          8,
          1,
          1,
          0,
          0,
          now() - interval '1 minute',
          now()
        )`,
      [randomUUID(), claimId, seed.userId],
    );

    const response = await app!.inject({
      method: 'GET',
      url: `/v1/claims/${claimId}`,
      headers: { authorization: seed.authHeader },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      data: {
        claim: { id: string };
        lines: unknown[];
        documents: unknown[];
        latestAuditSession: { decision: string } | null;
      };
    };

    expect(body.data.claim.id).toBe(claimId);
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.documents).toHaveLength(1);
    expect(body.data.latestAuditSession?.decision).toBe('WARNING');
  });

  it('Patch with correct version updates claim and writes audit trail', async () => {
    const seed = await seedBaseData(pool!);

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: createClaimPayload(seed.facilityId, '8'),
    });

    const createdBody = created.json() as { data: { claim: { id: string; version: number } } };
    const claimId = createdBody.data.claim.id;

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/v1/claims/${claimId}`,
      headers: {
        authorization: seed.authHeader,
        'if-match': '1',
      },
      payload: {
        patientName: 'Updated Patient',
        lines: [
          {
            shaServiceCode: 'SVC-UPDATED',
            description: 'Updated line',
            quantity: 2,
            unitPrice: 250,
          },
        ],
      },
    });

    expect(patched.statusCode).toBe(200);

    const patchedBody = patched.json() as {
      data: {
        claim: { version: number; patientName: string | null };
        lines: Array<{ lineNumber: number; quantity: number }>;
      };
    };

    expect(patchedBody.data.claim.version).toBe(2);
    expect(patchedBody.data.claim.patientName).toBe('Updated Patient');
    expect(patchedBody.data.lines).toHaveLength(1);
    expect(patchedBody.data.lines[0]?.quantity).toBe(2);

    const auditRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM audit_trail
        WHERE claim_id = $1::uuid
          AND action = 'CLAIM_UPDATED'::audit_action`,
      [claimId],
    );

    expect(Number.parseInt(auditRows.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('Patch with wrong version returns 409 CONCURRENCY_CONFLICT', async () => {
    const seed = await seedBaseData(pool!);

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: createClaimPayload(seed.facilityId, '9'),
    });

    const claimId = (created.json() as { data: { claim: { id: string } } }).data.claim.id;

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/v1/claims/${claimId}`,
      headers: {
        authorization: seed.authHeader,
        'if-match': '999',
      },
      payload: {
        patientName: 'Nope',
      },
    });

    expect(patched.statusCode).toBe(409);

    const body = patched.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.CONCURRENCY_CONFLICT);
  });

  it('Patch on non-DRAFT/non-CORRECTIONS_IN_PROGRESS claim returns 422', async () => {
    const seed = await seedBaseData(pool!);

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/claims',
      headers: { authorization: seed.authHeader },
      payload: createClaimPayload(seed.facilityId, '10'),
    });

    const claimId = (created.json() as { data: { claim: { id: string } } }).data.claim.id;

    await pool!.query(`UPDATE claims SET status = 'PASSED'::claim_status WHERE id = $1::uuid`, [claimId]);

    const patched = await app!.inject({
      method: 'PATCH',
      url: `/v1/claims/${claimId}`,
      headers: {
        authorization: seed.authHeader,
        'if-match': '1',
      },
      payload: {
        patientName: 'Should fail',
      },
    });

    expect(patched.statusCode).toBe(422);

    const body = patched.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
  });
});






