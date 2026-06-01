import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { ErrorCode } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getAdminPool } from '../db/client.js';
import { buildServer } from '../server.js';
import { encryptTotpSecret } from '../services/auth-service.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const currentDir = dirname(fileURLToPath(import.meta.url));
const testStoragePath = resolve(currentDir, '../../../.tmp-auth-storage');
const testKeysPath = resolve(currentDir, '../../../.tmp-auth-keys');

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  email: string;
  password: string;
  totpSecret: string;
}

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

async function createTestKeys(): Promise<Buffer> {
  await rm(testKeysPath, { recursive: true, force: true });
  await mkdir(testKeysPath, { recursive: true });

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const masterKey = randomBytes(32);

  await writeFile(resolve(testKeysPath, 'jwt_private.pem'), privatePem, 'utf8');
  await writeFile(resolve(testKeysPath, 'jwt_public.pem'), publicPem, 'utf8');
  await writeFile(resolve(testKeysPath, 'master.key'), masterKey.toString('hex'), 'utf8');

  return masterKey;
}

async function runMigrations(pool: Pool): Promise<void> {
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

async function resetStoragePath(): Promise<void> {
  await rm(testStoragePath, { recursive: true, force: true });
  await mkdir(testStoragePath, { recursive: true });
}

async function seedUser(pool: Pool, masterKey: Buffer): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();
  const email = 'auth.officer@example.org';
  const password = 'Password!123';
  const totpSecret = authenticator.generateSecret();

  const passwordHash = await bcrypt.hash(password, 12);
  const encryptedTotp = encryptTotpSecret(totpSecret, masterKey);

  await pool.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3)`,
    [tenantId, 'Auth Tenant', `tenant-${tenantId.slice(0, 8)}`],
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
        failed_login_count,
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
        0,
        false
      )`,
    [userId, tenantId, facilityId, email, 'Auth Officer', passwordHash],
  );

  await pool.query(
    `INSERT INTO mfa_devices (
        user_id,
        device_type,
        device_name,
        secret_encrypted,
        is_active
      ) VALUES (
        $1::uuid,
        'TOTP',
        'Primary Authenticator',
        $2,
        true
      )`,
    [userId, encryptedTotp],
  );

  return {
    tenantId,
    facilityId,
    userId,
    email,
    password,
    totpSecret,
  };
}

async function login(app: FastifyInstance, seed: SeedContext, password: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: {
      'x-tenant-id': seed.tenantId,
    },
    payload: {
      email: seed.email,
      password,
    },
  });
}

async function establishSession(app: FastifyInstance, seed: SeedContext, password: string): Promise<SessionTokens> {
  const loginResponse = await login(app, seed, password);
  expect(loginResponse.statusCode).toBe(200);

  const loginBody = loginResponse.json() as {
    data: {
      requiresMfa: boolean;
      mfaToken: string;
    };
  };

  expect(loginBody.data.requiresMfa).toBe(true);

  const code = authenticator.generate(seed.totpSecret);

  const verifyResponse = await app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/verify',
    payload: {
      mfaToken: loginBody.data.mfaToken,
      code,
    },
  });

  expect(verifyResponse.statusCode).toBe(200);

  const verifyBody = verifyResponse.json() as {
    data: {
      accessToken: string;
      refreshToken: string;
    };
  };

  return {
    accessToken: verifyBody.data.accessToken,
    refreshToken: verifyBody.data.refreshToken,
  };
}

integrationDescribe('Auth foundation integration', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;
  let masterKey: Buffer;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }

    masterKey = await createTestKeys();

    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: integrationDatabaseUrl,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '1000',
        STORAGE_PATH: testStoragePath,
        KEY_PATH: testKeysPath,
        MAX_LOGIN_ATTEMPTS: '3',
        LOCKOUT_DURATION_MINUTES: '15',
        REQUIRE_MFA: 'true',
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
    await resetStoragePath();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    await closePool();
    await rm(testStoragePath, { recursive: true, force: true });
    await rm(testKeysPath, { recursive: true, force: true });
  });

  it('locks account after configured failed attempts and writes USER_LOCKED', async () => {
    const seed = await seedUser(pool!, masterKey);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await login(app!, seed, 'WrongPass!999');
      expect(response.statusCode).toBe(401);

      const body = response.json() as { errors: Array<{ code: ErrorCode }> };
      expect(body.errors[0]?.code).toBe(ErrorCode.UNAUTHORIZED);
    }

    const state = await pool!.query<{ failed_login_count: number; locked_until: string | null }>(
      `SELECT failed_login_count, locked_until
         FROM users
        WHERE id = $1::uuid`,
      [seed.userId],
    );

    expect(state.rows[0]?.failed_login_count).toBe(3);
    expect(state.rows[0]?.locked_until).toBeTruthy();

    const lockedAuditCount = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_trail
        WHERE tenant_id = $1::uuid
          AND user_id = $2::uuid
          AND action = 'USER_LOCKED'::audit_action`,
      [seed.tenantId, seed.userId],
    );

    expect(Number.parseInt(lockedAuditCount.rows[0]?.count ?? '0', 10)).toBe(1);

    const correctPasswordAttempt = await login(app!, seed, seed.password);
    expect(correctPasswordAttempt.statusCode).toBe(401);
  });

  it('completes login + MFA, supports mfa setup, and writes login audits', async () => {
    const seed = await seedUser(pool!, masterKey);

    const tokens = await establishSession(app!, seed, seed.password);

    const setupResponse = await app!.inject({
      method: 'POST',
      url: '/v1/auth/mfa/setup',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
      },
      payload: {
        deviceName: 'Backup Device',
      },
    });

    expect(setupResponse.statusCode).toBe(201);

    const setupBody = setupResponse.json() as {
      data: { deviceId: string; otpauthUrl: string; secret: string };
    };

    expect(setupBody.data.deviceId).toBeTruthy();
    expect(setupBody.data.secret).toBeTruthy();
    expect(setupBody.data.otpauthUrl.startsWith('otpauth://totp/')).toBe(true);

    const loginAuditCount = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_trail
        WHERE tenant_id = $1::uuid
          AND user_id = $2::uuid
          AND action = 'USER_LOGIN'::audit_action`,
      [seed.tenantId, seed.userId],
    );

    const mfaAuditCount = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_trail
        WHERE tenant_id = $1::uuid
          AND user_id = $2::uuid
          AND action = 'USER_MFA_VERIFIED'::audit_action`,
      [seed.tenantId, seed.userId],
    );

    expect(Number.parseInt(loginAuditCount.rows[0]?.count ?? '0', 10)).toBe(1);
    expect(Number.parseInt(mfaAuditCount.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('rotates refresh tokens and revokes family on reuse (theft detection)', async () => {
    const seed = await seedUser(pool!, masterKey);
    const initialSession = await establishSession(app!, seed, seed.password);

    const firstRefresh = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {
        refreshToken: initialSession.refreshToken,
      },
    });

    expect(firstRefresh.statusCode).toBe(200);

    const firstRefreshBody = firstRefresh.json() as {
      data: {
        refreshToken: string;
      };
    };

    const rotatedRefreshToken = firstRefreshBody.data.refreshToken;

    const reuseOldToken = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {
        refreshToken: initialSession.refreshToken,
      },
    });

    expect(reuseOldToken.statusCode).toBe(401);

    const useRotatedAfterTheft = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {
        refreshToken: rotatedRefreshToken,
      },
    });

    expect(useRotatedAfterTheft.statusCode).toBe(401);
  });

  it('changes password with history enforcement and logout revokes refresh family', async () => {
    const seed = await seedUser(pool!, masterKey);
    const initialSession = await establishSession(app!, seed, seed.password);

    const changeResponse = await app!.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: {
        authorization: `Bearer ${initialSession.accessToken}`,
      },
      payload: {
        currentPassword: seed.password,
        newPassword: 'NewPassword!456',
      },
    });

    expect(changeResponse.statusCode).toBe(200);

    const oldPasswordLogin = await login(app!, seed, seed.password);
    expect(oldPasswordLogin.statusCode).toBe(401);

    const newSession = await establishSession(app!, seed, 'NewPassword!456');

    const reuseOldPassword = await app!.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: {
        authorization: `Bearer ${newSession.accessToken}`,
      },
      payload: {
        currentPassword: 'NewPassword!456',
        newPassword: seed.password,
      },
    });

    expect(reuseOldPassword.statusCode).toBe(400);

    const logoutResponse = await app!.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: {
        refreshToken: newSession.refreshToken,
      },
    });

    expect(logoutResponse.statusCode).toBe(200);

    const refreshAfterLogout = await app!.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {
        refreshToken: newSession.refreshToken,
      },
    });

    expect(refreshAfterLogout.statusCode).toBe(401);
  }, 15_000);
});
