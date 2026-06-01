import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaimStatus,
  DomainError,
  ErrorCode,
  VALID_TRANSITIONS,
  isValidTransition,
} from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getAdminPool, getTenantDb, runWithTenant } from '../db/client.js';
import { buildServer } from '../server.js';
import { createStateMachineWorkflow } from '../workflows/state-machine.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

interface SeedContext {
  tenantId: string;
  facilityId: string;
  officerUserId: string;
  supervisorUserId: string;
  officerAuthHeader: string;
  supervisorAuthHeader: string;
}

function createAuthHeader(context: {
  tenantId: string;
  facilityId: string;
  userId: string;
  role: string;
  mfaVerifiedAt?: number;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: context.userId,
      tenantId: context.tenantId,
      facilityId: context.facilityId,
      role: context.role,
      mfaVerifiedAt: context.mfaVerifiedAt,
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
  const officerUserId = randomUUID();
  const supervisorUserId = randomUUID();

  await pool.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3)`,
    [tenantId, 'State Machine Tenant', `tenant-${tenantId.slice(0, 8)}`],
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
      ) VALUES
      (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'officer@example.org',
        'Claims Officer',
        '$2b$12$examplehashforintegrationtests000000000000000000',
        'claims_officer'::user_role,
        true,
        false
      ),
      (
        $4::uuid,
        $2::uuid,
        $3::uuid,
        'supervisor@example.org',
        'Supervisor',
        '$2b$12$examplehashforintegrationtests000000000000000000',
        'supervisor'::user_role,
        true,
        false
      )`,
    [officerUserId, tenantId, facilityId, supervisorUserId],
  );

  return {
    tenantId,
    facilityId,
    officerUserId,
    supervisorUserId,
    officerAuthHeader: createAuthHeader({
      tenantId,
      facilityId,
      userId: officerUserId,
      role: 'claims_officer',
    }),
    supervisorAuthHeader: createAuthHeader({
      tenantId,
      facilityId,
      userId: supervisorUserId,
      role: 'supervisor',
      mfaVerifiedAt: Date.now(),
    }),
  };
}

async function createClaimWithStatus(
  pool: Pool,
  context: SeedContext,
  status: ClaimStatus,
): Promise<string> {
  const claimId = randomUUID();

  await pool.query(
    `INSERT INTO claims (
        id,
        tenant_id,
        facility_id,
        payer_id,
        patient_sha_id,
        patient_name_enc,
        claim_type,
        visit_type,
        admission_date,
        primary_diagnosis_code,
        status,
        created_by
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        (SELECT id FROM payers WHERE slug = 'sha'),
        $4,
        $5,
        'OUTPATIENT'::claim_type,
        'OP'::visit_type,
        '2026-03-05'::date,
        'D-STATE',
        $6::claim_status,
        $7::uuid
      )`,
    [
      claimId,
      context.tenantId,
      context.facilityId,
      `CR${Math.floor(Math.random() * 900000000 + 100000000)}-1`,
      'Transition Patient',
      status,
      context.officerUserId,
    ],
  );

  return claimId;
}

async function insertDummyDocument(pool: Pool, context: SeedContext, claimId: string): Promise<void> {
  await pool.query(
    `INSERT INTO documents (
        id,
        claim_id,
        tenant_id,
        doc_type,
        processing_route,
        mime_type,
        original_filename,
        page_count,
        file_size_bytes,
        storage_path,
        sha256,
        processing_status,
        uploaded_by,
        uploaded_at
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $4::uuid,
        'PHYSICIAN_NOTES'::doc_type,
        'FULL_OCR_EXTRACT'::doc_processing_route,
        'application/pdf',
        'notes.pdf',
        1,
        1024,
        '/tmp/notes.pdf',
        'dummyhash',
        'COMPLETED'::doc_processing_status,
        $3::uuid,
        now()
      )`,
    [randomUUID(), claimId, context.officerUserId, context.tenantId],
  );
}

async function insertOverrideRequestedAudit(
  pool: Pool,
  context: SeedContext,
  claimId: string,
  requesterUserId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_trail (
        tenant_id,
        claim_id,
        user_id,
        action,
        detail_json
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        'OVERRIDE_REQUESTED'::audit_action,
        $4::jsonb
      )`,
    [context.tenantId, claimId, requesterUserId, JSON.stringify({ reason: 'Need override for emergency case' })],
  );
}

integrationDescribe('State machine + override integration', () => {
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

  it('every valid transition from the state diagram succeeds and writes audit trail', async () => {
    const context = await seedBaseData(pool!);
    const workflow = createStateMachineWorkflow(getTenantDb(config));

    const validTransitions: Array<{ from: ClaimStatus; to: ClaimStatus }> = [];

    for (const [from, targets] of VALID_TRANSITIONS.entries()) {
      for (const to of targets) {
        validTransitions.push({ from, to });
      }
    }

    for (const transition of validTransitions) {
      const claimId = await createClaimWithStatus(pool!, context, transition.from);
      let actorUserId = context.officerUserId;
      let actorRole = 'claims_officer';
      let metadata: Record<string, unknown> | undefined;
      let expectedFinalStatus = transition.to;

      if (
        transition.from === ClaimStatus.CORRECTIONS_IN_PROGRESS &&
        transition.to === ClaimStatus.DOCUMENTS_UPLOADED
      ) {
        await insertDummyDocument(pool!, context, claimId);
      }

      if (transition.from === ClaimStatus.PROCESSING && transition.to === ClaimStatus.AUDIT_COMPLETE) {
        metadata = { decision: ClaimStatus.PASSED };
        expectedFinalStatus = ClaimStatus.PASSED;
      }

      if (transition.from === ClaimStatus.OVERRIDE_PENDING && transition.to === ClaimStatus.OVERRIDE_APPROVED) {
        await insertOverrideRequestedAudit(pool!, context, claimId, context.officerUserId);
        actorUserId = context.supervisorUserId;
        actorRole = 'supervisor';
      }

      const result = await runWithTenant(context.tenantId, () =>
        workflow.transitionClaim({
          claimId,
          tenantId: context.tenantId,
          toStatus: transition.to,
          userId: actorUserId,
          userRole: actorRole,
          metadata,
        }),
      );

      expect(result.status).toBe(expectedFinalStatus);

      const stateAuditCount = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM audit_trail
          WHERE tenant_id = $1::uuid
            AND claim_id = $2::uuid
            AND action = 'CLAIM_STATE_CHANGED'::audit_action
            AND from_state = $3::claim_status
            AND to_state = $4::claim_status`,
        [context.tenantId, claimId, transition.from, transition.to],
      );

      expect(Number.parseInt(stateAuditCount.rows[0]?.count ?? '0', 10)).toBeGreaterThanOrEqual(1);
    }
  });

  it('every invalid transition is rejected with 422 INVALID_STATE_TRANSITION', async () => {
    const context = await seedBaseData(pool!);
    const workflow = createStateMachineWorkflow(getTenantDb(config));
    const claimId = await createClaimWithStatus(pool!, context, ClaimStatus.DRAFT);

    const statuses = Object.values(ClaimStatus);

    for (const fromStatus of statuses) {
      for (const toStatus of statuses) {
        if (fromStatus === toStatus) {
          continue;
        }

        if (isValidTransition(fromStatus, toStatus)) {
          continue;
        }

        await pool!.query(
          `UPDATE claims
              SET status = $2::claim_status,
                  version = 1,
                  updated_at = now()
            WHERE id = $1::uuid`,
          [claimId, fromStatus],
        );

        try {
          await runWithTenant(context.tenantId, () =>
            workflow.transitionClaim({
              claimId,
              tenantId: context.tenantId,
              toStatus,
              userId: context.supervisorUserId,
              userRole: 'supervisor',
            }),
          );

          throw new Error(`Transition unexpectedly succeeded: ${fromStatus} -> ${toStatus}`);
        } catch (error) {
          expect(error).toBeInstanceOf(DomainError);

          const domainError = error as DomainError;
          expect(domainError.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
          expect(domainError.httpStatus).toBe(422);
        }
      }
    }
  });

  it('override request enforces minimum reason length', async () => {
    const context = await seedBaseData(pool!);
    const claimId = await createClaimWithStatus(pool!, context, ClaimStatus.FAILED);

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/override`,
      headers: {
        authorization: context.officerAuthHeader,
      },
      payload: {
        reason: 'too short',
      },
    });

    expect(response.statusCode).toBe(400);

    const body = response.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('override approval requires a different user than requester', async () => {
    const context = await seedBaseData(pool!);
    const claimId = await createClaimWithStatus(pool!, context, ClaimStatus.FAILED);

    const requestOverride = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/override`,
      headers: {
        authorization: context.supervisorAuthHeader,
      },
      payload: {
        reason: 'Override needed because emergency treatment was clinically necessary',
      },
    });

    expect(requestOverride.statusCode).toBe(200);

    const approveSameUser = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/override/approve`,
      headers: {
        authorization: context.supervisorAuthHeader,
      },
      payload: {
        supervisorNotes: 'Attempting to self-approve',
      },
    });

    expect(approveSameUser.statusCode).toBe(422);

    const body = approveSameUser.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
  });
});
