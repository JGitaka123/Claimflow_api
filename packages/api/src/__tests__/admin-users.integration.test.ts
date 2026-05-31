import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode, UserRole, type ApiErrorResponse } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getPool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

interface SeedContext {
  tenantId: string;
  facilityId: string;
  secondTenantId: string;
  secondFacilityId: string;
  userIds: Record<UserRole.ADMIN | UserRole.SUPER_ADMIN | UserRole.CLAIMS_OFFICER, string>;
}

interface AdminUserResponse {
  id: string;
  tenantId: string;
  facilityId: string | null;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
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

function authFor(context: SeedContext, role: UserRole, mfaVerifiedAt?: number): string {
  if (role !== UserRole.ADMIN && role !== UserRole.SUPER_ADMIN && role !== UserRole.CLAIMS_OFFICER) {
    throw new Error(`Unsupported test role: ${role}`);
  }

  return createAuthHeader({
    tenantId: context.tenantId,
    facilityId: context.facilityId,
    userId: context.userIds[role],
    role,
    mfaVerifiedAt,
  });
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

async function insertUser(params: {
  pool: Pool;
  id: string;
  tenantId: string;
  facilityId: string;
  email: string;
  displayName: string;
  role: UserRole;
}): Promise<void> {
  await params.pool.query(
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
    [params.id, params.tenantId, params.facilityId, params.email, params.displayName, params.role],
  );
}

async function seedBaseData(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const secondTenantId = randomUUID();
  const secondFacilityId = randomUUID();

  const userIds: Record<UserRole.ADMIN | UserRole.SUPER_ADMIN | UserRole.CLAIMS_OFFICER, string> = {
    [UserRole.ADMIN]: randomUUID(),
    [UserRole.SUPER_ADMIN]: randomUUID(),
    [UserRole.CLAIMS_OFFICER]: randomUUID(),
  };

  await pool.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3), ($4::uuid, $5, $6)`,
    [
      tenantId,
      'Admin Users Tenant',
      `admin-users-${tenantId.slice(0, 8)}`,
      secondTenantId,
      'Other Tenant',
      `other-${secondTenantId.slice(0, 8)}`,
    ],
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
      ) VALUES
      (
        $1::uuid,
        $2::uuid,
        'Mary Help Mission',
        'FID-22-106718-4',
        '000210',
        'LEVEL_4',
        'Kiambu',
        true
      ),
      (
        $3::uuid,
        $4::uuid,
        'Other Facility',
        'FID-00-000000-0',
        '000000',
        'LEVEL_4',
        'Nairobi',
        true
      )`,
    [facilityId, tenantId, secondFacilityId, secondTenantId],
  );

  await insertUser({
    pool,
    id: userIds[UserRole.ADMIN],
    tenantId,
    facilityId,
    email: 'admin@example.org',
    displayName: 'Admin User',
    role: UserRole.ADMIN,
  });

  await insertUser({
    pool,
    id: userIds[UserRole.SUPER_ADMIN],
    tenantId,
    facilityId,
    email: 'super@example.org',
    displayName: 'Super Admin',
    role: UserRole.SUPER_ADMIN,
  });

  await insertUser({
    pool,
    id: userIds[UserRole.CLAIMS_OFFICER],
    tenantId,
    facilityId,
    email: 'officer@example.org',
    displayName: 'Claims Officer',
    role: UserRole.CLAIMS_OFFICER,
  });

  return {
    tenantId,
    facilityId,
    secondTenantId,
    secondFacilityId,
    userIds,
  };
}

integrationDescribe('Admin users routes integration', () => {
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

  it('supports create/list/update/reset lifecycle for admin users', async () => {
    const context = await seedBaseData(pool!);

    const createResponse = await app!.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        email: 'NEW.USER@Example.org',
        displayName: 'New User',
        role: UserRole.AUDITOR,
        facilityId: context.facilityId,
        temporaryPassword: 'TempPass!1234',
      },
    });

    expect(createResponse.statusCode).toBe(201);

    const createBody = createResponse.json() as { data: { user: AdminUserResponse } };
    expect(createBody.data.user.email).toBe('new.user@example.org');
    expect(createBody.data.user.role).toBe(UserRole.AUDITOR);
    expect(createBody.data.user.mustChangePassword).toBe(true);

    const createdUserId = createBody.data.user.id;

    const listActiveResponse = await app!.inject({
      method: 'GET',
      url: '/v1/admin/users',
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
    });

    expect(listActiveResponse.statusCode).toBe(200);
    const listActiveBody = listActiveResponse.json() as { data: { users: AdminUserResponse[] } };
    expect(listActiveBody.data.users.some((user) => user.id === createdUserId)).toBe(true);

    const updateResponse = await app!.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${createdUserId}`,
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        role: UserRole.VIEWER,
        isActive: false,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updateBody = updateResponse.json() as { data: { user: AdminUserResponse } };
    expect(updateBody.data.user.role).toBe(UserRole.VIEWER);
    expect(updateBody.data.user.isActive).toBe(false);

    const listInactiveFilteredResponse = await app!.inject({
      method: 'GET',
      url: '/v1/admin/users',
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
    });

    const listInactiveFilteredBody = listInactiveFilteredResponse.json() as { data: { users: AdminUserResponse[] } };
    expect(listInactiveFilteredBody.data.users.some((user) => user.id === createdUserId)).toBe(false);

    const listIncludeInactiveResponse = await app!.inject({
      method: 'GET',
      url: '/v1/admin/users?includeInactive=true',
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
    });

    const listIncludeInactiveBody = listIncludeInactiveResponse.json() as { data: { users: AdminUserResponse[] } };
    expect(listIncludeInactiveBody.data.users.some((user) => user.id === createdUserId && user.isActive === false)).toBe(true);

    const resetWithoutMfa = await app!.inject({
      method: 'POST',
      url: `/v1/admin/users/${createdUserId}/reset-password`,
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        temporaryPassword: 'ResetPass!9876',
      },
    });

    expect(resetWithoutMfa.statusCode).toBe(401);
    expectCode(resetWithoutMfa.body, ErrorCode.MFA_REQUIRED);

    const resetWithMfa = await app!.inject({
      method: 'POST',
      url: `/v1/admin/users/${createdUserId}/reset-password`,
      headers: {
        authorization: authFor(context, UserRole.ADMIN, Date.now()),
      },
      payload: {
        temporaryPassword: 'ResetPass!9876',
      },
    });

    expect(resetWithMfa.statusCode).toBe(200);

    const selfDeactivate = await app!.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${context.userIds[UserRole.ADMIN]}`,
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        isActive: false,
      },
    });

    expect(selfDeactivate.statusCode).toBe(400);
    expectCode(selfDeactivate.body, ErrorCode.VALIDATION_ERROR);

    const auditCounts = await pool!.query<{ action: string; count: string }>(
      `SELECT action::text AS action, COUNT(*)::text AS count
         FROM audit_trail
        WHERE tenant_id = $1::uuid
          AND action IN (
            'USER_CREATED'::audit_action,
            'USER_UPDATED'::audit_action,
            'USER_PASSWORD_RESET'::audit_action
          )
        GROUP BY action`,
      [context.tenantId],
    );

    const map = new Map(auditCounts.rows.map((row) => [row.action, Number.parseInt(row.count, 10)]));
    expect(map.get('USER_CREATED')).toBeGreaterThanOrEqual(1);
    expect(map.get('USER_UPDATED')).toBeGreaterThanOrEqual(1);
    expect(map.get('USER_PASSWORD_RESET')).toBeGreaterThanOrEqual(1);
  });

  it('forbids non-admin roles from managing users', async () => {
    const context = await seedBaseData(pool!);

    const endpoints = [
      { method: 'GET', url: '/v1/admin/users', payload: undefined },
      {
        method: 'POST',
        url: '/v1/admin/users',
        payload: {
          email: 'blocked@example.org',
          displayName: 'Blocked',
          role: UserRole.VIEWER,
          facilityId: context.facilityId,
          temporaryPassword: 'BlockedPass!123',
        },
      },
      {
        method: 'PATCH',
        url: `/v1/admin/users/${context.userIds[UserRole.ADMIN]}`,
        payload: {
          displayName: 'Nope',
        },
      },
      {
        method: 'POST',
        url: `/v1/admin/users/${context.userIds[UserRole.ADMIN]}/reset-password`,
        payload: {
          temporaryPassword: 'BlockedPass!123',
        },
      },
    ] as const;

    for (const endpoint of endpoints) {
      const response = await app!.inject({
        method: endpoint.method,
        url: endpoint.url,
        headers: {
          authorization: authFor(context, UserRole.CLAIMS_OFFICER, Date.now()),
        },
        payload: endpoint.payload,
      });

      expect(response.statusCode).toBe(403);
      expectCode(response.body, ErrorCode.FORBIDDEN);
    }
  });

  it('enforces super admin assignment and tenant facility scoping', async () => {
    const context = await seedBaseData(pool!);

    const adminCreatesSuperAdmin = await app!.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        email: 'forbidden-super@example.org',
        displayName: 'Forbidden Super',
        role: UserRole.SUPER_ADMIN,
        facilityId: context.facilityId,
        temporaryPassword: 'TempPass!1234',
      },
    });

    expect(adminCreatesSuperAdmin.statusCode).toBe(403);
    expectCode(adminCreatesSuperAdmin.body, ErrorCode.FORBIDDEN);

    const adminUsesOtherTenantFacility = await app!.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        email: 'wrong-facility@example.org',
        displayName: 'Wrong Facility',
        role: UserRole.VIEWER,
        facilityId: context.secondFacilityId,
        temporaryPassword: 'TempPass!1234',
      },
    });

    expect(adminUsesOtherTenantFacility.statusCode).toBe(400);
    expectCode(adminUsesOtherTenantFacility.body, ErrorCode.VALIDATION_ERROR);

    const superAdminCreatesSuperAdmin = await app!.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: {
        authorization: authFor(context, UserRole.SUPER_ADMIN),
      },
      payload: {
        email: 'allowed-super@example.org',
        displayName: 'Allowed Super',
        role: UserRole.SUPER_ADMIN,
        facilityId: context.facilityId,
        temporaryPassword: 'TempPass!1234',
      },
    });

    expect(superAdminCreatesSuperAdmin.statusCode).toBe(201);

    const createdSuperAdminBody = superAdminCreatesSuperAdmin.json() as { data: { user: AdminUserResponse } };

    const adminUpdatesSuperAdmin = await app!.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${createdSuperAdminBody.data.user.id}`,
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        role: UserRole.VIEWER,
      },
    });

    expect(adminUpdatesSuperAdmin.statusCode).toBe(403);
    expectCode(adminUpdatesSuperAdmin.body, ErrorCode.FORBIDDEN);

    const adminPromotesOfficerToSuperAdmin = await app!.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${context.userIds[UserRole.CLAIMS_OFFICER]}`,
      headers: {
        authorization: authFor(context, UserRole.ADMIN),
      },
      payload: {
        role: UserRole.SUPER_ADMIN,
      },
    });

    expect(adminPromotesOfficerToSuperAdmin.statusCode).toBe(403);
    expectCode(adminPromotesOfficerToSuperAdmin.body, ErrorCode.FORBIDDEN);

    const superAdminPromotesOfficerToSuperAdmin = await app!.inject({
      method: 'PATCH',
      url: `/v1/admin/users/${context.userIds[UserRole.CLAIMS_OFFICER]}`,
      headers: {
        authorization: authFor(context, UserRole.SUPER_ADMIN),
      },
      payload: {
        role: UserRole.SUPER_ADMIN,
      },
    });

    expect(superAdminPromotesOfficerToSuperAdmin.statusCode).toBe(200);

    const promotedOfficerBody = superAdminPromotesOfficerToSuperAdmin.json() as { data: { user: AdminUserResponse } };
    expect(promotedOfficerBody.data.user.role).toBe(UserRole.SUPER_ADMIN);
  });
});

