import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaimStatus,
  ErrorCode,
  UserRole,
  type ApiErrorResponse,
} from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getPool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const ALL_ROLES: UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.SUPERVISOR,
  UserRole.CLAIMS_OFFICER,
  UserRole.AUDITOR,
  UserRole.VIEWER,
];

const CLAIMS_OFFICER_AND_ABOVE = new Set<UserRole>([
  UserRole.CLAIMS_OFFICER,
  UserRole.SUPERVISOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
]);

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userIds: Record<UserRole, string>;
}

function createAuthHeader(params: {
  tenantId: string;
  facilityId: string;
  userId: string;
  role: UserRole;
  mfaVerifiedAt?: number;
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: params.userId,
      tenantId: params.tenantId,
      facilityId: params.facilityId,
      role: params.role,
      mfaVerifiedAt: params.mfaVerifiedAt,
    }),
  ).toString('base64url');

  return `Bearer ${header}.${payload}.signature`;
}

function authForRole(context: SeedContext, role: UserRole, mfaVerifiedAt?: number): string {
  return createAuthHeader({
    tenantId: context.tenantId,
    facilityId: context.facilityId,
    userId: context.userIds[role],
    role,
    mfaVerifiedAt,
  });
}

function createClaimPayload(index: number) {
  return {
    patientShaId: `CR${100000000 + index}-1`,
    patientName: `RBAC Patient ${index}`,
    patientNationalId: `RBAC-ID-${index}`,
    hmisRef: `RBAC-HMIS-${index}`,
    claimType: 'OUTPATIENT',
    visitType: 'OP',
    admissionDate: '2026-03-06',
    dischargeDate: null,
    primaryDiagnosisCode: 'D-RBAC',
    shaBenefitPackage: 'SHA-BASE',
    preauthNumber: null,
    accommodationType: null,
    patientDisposition: null,
    lines: [
      {
        lineNumber: 1,
        shaServiceCode: 'SVC-RBAC',
        description: 'Consultation',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  };
}

function expectCode(responseBody: string, code: ErrorCode): void {
  const payload = JSON.parse(responseBody) as ApiErrorResponse;
  expect(payload.errors[0]?.code).toBe(code);
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
      await client.query(sql);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockKey]);
    } catch {
      // ignore unlock failures
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

  const userIds: Record<UserRole, string> = {
    [UserRole.SUPER_ADMIN]: randomUUID(),
    [UserRole.ADMIN]: randomUUID(),
    [UserRole.SUPERVISOR]: randomUUID(),
    [UserRole.CLAIMS_OFFICER]: randomUUID(),
    [UserRole.AUDITOR]: randomUUID(),
    [UserRole.VIEWER]: randomUUID(),
  };

  await pool.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3)`,
    [tenantId, 'RBAC Tenant', `rbac-${tenantId.slice(0, 8)}`],
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

  const roles = ALL_ROLES;

  for (const role of roles) {
    const userId = userIds[role];

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
          '$2b$12$examplehashforintegrationtests000000000000000000',
          $6::user_role,
          true,
          false
        )`,
      [
        userId,
        tenantId,
        facilityId,
        `${role}@example.org`,
        `${role} user`,
        role,
      ],
    );
  }

  return {
    tenantId,
    facilityId,
    userIds,
  };
}

async function insertClaim(pool: Pool, context: SeedContext, status: ClaimStatus): Promise<string> {
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
        '2026-03-06'::date,
        'D-RBAC',
        $6::claim_status,
        $7::uuid
      )`,
    [
      claimId,
      context.tenantId,
      context.facilityId,
      `CR${Math.floor(Math.random() * 900000000 + 100000000)}-1`,
      'RBAC Patient',
      status,
      context.userIds[UserRole.CLAIMS_OFFICER],
    ],
  );

  return claimId;
}

async function insertRulepack(pool: Pool, version: string): Promise<void> {
  const [major, minor, patch] = version.split('.').map((value) => Number.parseInt(value, 10));

  await pool.query(
    `INSERT INTO rulepacks (
        id,
        version_semver,
        version_major,
        version_minor,
        version_patch,
        checksum,
        rule_count,
        is_activated
      ) VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        $6,
        0,
        false
      )`,
    [randomUUID(), version, major, minor, patch, `checksum-${version}`],
  );
}

integrationDescribe('RBAC + step-up MFA integration', () => {
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

  it('enforces claims create/update permissions', async () => {
    const context = await seedBaseData(pool!);

    let index = 1;

    for (const role of ALL_ROLES) {
      const response = await app!.inject({
        method: 'POST',
        url: '/v1/claims',
        headers: {
          authorization: authForRole(context, role),
        },
        payload: createClaimPayload(index),
      });

      if (CLAIMS_OFFICER_AND_ABOVE.has(role)) {
        expect(response.statusCode).not.toBe(403);
      } else {
        expect(response.statusCode).toBe(403);
        expectCode(response.body, ErrorCode.FORBIDDEN);
      }

      index += 1;
    }

    for (const role of ALL_ROLES) {
      const claimId = await insertClaim(pool!, context, ClaimStatus.DRAFT);

      const response = await app!.inject({
        method: 'PATCH',
        url: `/v1/claims/${claimId}`,
        headers: {
          authorization: authForRole(context, role),
          'if-match': '1',
        },
        payload: {
          patientName: `Updated by ${role}`,
        },
      });

      if (CLAIMS_OFFICER_AND_ABOVE.has(role)) {
        expect(response.statusCode).not.toBe(403);
      } else {
        expect(response.statusCode).toBe(403);
        expectCode(response.body, ErrorCode.FORBIDDEN);
      }
    }
  });

  it('restricts trigger-audit and override-request to claims officer and above', async () => {
    const context = await seedBaseData(pool!);

    for (const role of ALL_ROLES) {
      const claimId = await insertClaim(pool!, context, ClaimStatus.DOCUMENTS_UPLOADED);

      const response = await app!.inject({
        method: 'POST',
        url: `/v1/claims/${claimId}/audit`,
        headers: {
          authorization: authForRole(context, role),
        },
        payload: {},
      });

      if (CLAIMS_OFFICER_AND_ABOVE.has(role)) {
        expect(response.statusCode).not.toBe(403);
      } else {
        expect(response.statusCode).toBe(403);
        expectCode(response.body, ErrorCode.FORBIDDEN);
      }
    }

    for (const role of ALL_ROLES) {
      const claimId = await insertClaim(pool!, context, ClaimStatus.FAILED);

      const response = await app!.inject({
        method: 'POST',
        url: `/v1/claims/${claimId}/override`,
        headers: {
          authorization: authForRole(context, role),
        },
        payload: {
          reason: 'Override requested because life-saving emergency intervention was clinically justified.',
        },
      });

      if (CLAIMS_OFFICER_AND_ABOVE.has(role)) {
        expect(response.statusCode).not.toBe(403);
      } else {
        expect(response.statusCode).toBe(403);
        expectCode(response.body, ErrorCode.FORBIDDEN);
      }
    }
  });

  it('enforces step-up MFA on override approval and export endpoints', async () => {
    const context = await seedBaseData(pool!);

    const overrideClaimId = await insertClaim(pool!, context, ClaimStatus.FAILED);

    const requestOverride = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${overrideClaimId}/override`,
      headers: {
        authorization: authForRole(context, UserRole.CLAIMS_OFFICER),
      },
      payload: {
        reason: 'Override requested because life-saving emergency intervention was clinically justified.',
      },
    });

    expect(requestOverride.statusCode).toBe(200);

    const noMfa = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${overrideClaimId}/override/approve`,
      headers: {
        authorization: authForRole(context, UserRole.SUPERVISOR),
      },
      payload: {
        supervisorNotes: 'approved',
      },
    });

    expect(noMfa.statusCode).toBe(401);
    expectCode(noMfa.body, ErrorCode.MFA_REQUIRED);

    const staleMfa = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${overrideClaimId}/override/approve`,
      headers: {
        authorization: authForRole(context, UserRole.SUPERVISOR, Date.now() - 6 * 60 * 1000),
      },
      payload: {
        supervisorNotes: 'approved',
      },
    });

    expect(staleMfa.statusCode).toBe(401);
    expectCode(staleMfa.body, ErrorCode.MFA_REQUIRED);

    const officerForbidden = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${overrideClaimId}/override/approve`,
      headers: {
        authorization: authForRole(context, UserRole.CLAIMS_OFFICER, Date.now()),
      },
      payload: {
        supervisorNotes: 'approved',
      },
    });

    expect(officerForbidden.statusCode).toBe(403);
    expectCode(officerForbidden.body, ErrorCode.FORBIDDEN);

    const freshMfa = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${overrideClaimId}/override/approve`,
      headers: {
        authorization: authForRole(context, UserRole.SUPERVISOR, Date.now()),
      },
      payload: {
        supervisorNotes: 'approved',
      },
    });

    expect(freshMfa.statusCode).toBe(200);

    const exportClaimId = await insertClaim(pool!, context, ClaimStatus.PASSED);

    const exportNoMfa = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${exportClaimId}/export`,
      headers: {
        authorization: authForRole(context, UserRole.CLAIMS_OFFICER),
      },
      payload: {},
    });

    expect(exportNoMfa.statusCode).toBe(401);
    expectCode(exportNoMfa.body, ErrorCode.MFA_REQUIRED);

    const exportWithMfa = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${exportClaimId}/export`,
      headers: {
        authorization: authForRole(context, UserRole.CLAIMS_OFFICER, Date.now()),
      },
      payload: {},
    });

    expect([400, 404, 202]).toContain(exportWithMfa.statusCode);

    const exportViewer = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${exportClaimId}/export`,
      headers: {
        authorization: authForRole(context, UserRole.VIEWER, Date.now()),
      },
      payload: {},
    });

    expect(exportViewer.statusCode).toBe(403);
    expectCode(exportViewer.body, ErrorCode.FORBIDDEN);
  });

  it('allows dashboard access to all authenticated roles', async () => {
    const context = await seedBaseData(pool!);

    for (const role of ALL_ROLES) {
      const response = await app!.inject({
        method: 'GET',
        url: '/v1/dashboard/overview',
        headers: {
          authorization: authForRole(context, role),
        },
      });

      expect(response.statusCode).toBe(200);
    }
  });

  it('enforces admin role + step-up for rulepack activation and scoped audit-trail access', async () => {
    const context = await seedBaseData(pool!);

    await insertRulepack(pool!, '1.2.3');
    await insertRulepack(pool!, '1.2.4');

    const adminNoMfa = await app!.inject({
      method: 'POST',
      url: '/v1/admin/rulepacks/1.2.3/activate',
      headers: {
        authorization: authForRole(context, UserRole.ADMIN),
      },
      payload: {},
    });

    expect(adminNoMfa.statusCode).toBe(401);
    expectCode(adminNoMfa.body, ErrorCode.MFA_REQUIRED);

    const adminWithMfa = await app!.inject({
      method: 'POST',
      url: '/v1/admin/rulepacks/1.2.3/activate',
      headers: {
        authorization: authForRole(context, UserRole.ADMIN, Date.now()),
      },
      payload: {},
    });

    expect(adminWithMfa.statusCode).toBe(200);

    const superAdminWithMfa = await app!.inject({
      method: 'POST',
      url: '/v1/admin/rulepacks/1.2.4/activate',
      headers: {
        authorization: authForRole(context, UserRole.SUPER_ADMIN, Date.now()),
      },
      payload: {},
    });

    expect(superAdminWithMfa.statusCode).toBe(200);

    const supervisorForbidden = await app!.inject({
      method: 'POST',
      url: '/v1/admin/rulepacks/1.2.4/activate',
      headers: {
        authorization: authForRole(context, UserRole.SUPERVISOR, Date.now()),
      },
      payload: {},
    });

    expect(supervisorForbidden.statusCode).toBe(403);
    expectCode(supervisorForbidden.body, ErrorCode.FORBIDDEN);

    const auditTrailAllowed: UserRole[] = [UserRole.ADMIN, UserRole.SUPERVISOR, UserRole.AUDITOR];
    const auditTrailDenied: UserRole[] = [UserRole.CLAIMS_OFFICER, UserRole.VIEWER, UserRole.SUPER_ADMIN];

    for (const role of auditTrailAllowed) {
      const response = await app!.inject({
        method: 'GET',
        url: '/v1/audit-trail',
        headers: {
          authorization: authForRole(context, role),
        },
      });

      expect(response.statusCode).toBe(200);
    }

    for (const role of auditTrailDenied) {
      const response = await app!.inject({
        method: 'GET',
        url: '/v1/audit-trail',
        headers: {
          authorization: authForRole(context, role),
        },
      });

      expect(response.statusCode).toBe(403);
      expectCode(response.body, ErrorCode.FORBIDDEN);
    }
  });
});
