import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { DomainError, ErrorCode, UserRole } from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { Config } from '../config.js';
import type { AuthContext } from '../types/request-context.js';

const JWT_ISSUER = 'claimflow';
const JWT_ACCESS_AUDIENCE = 'claimflow-api';
const JWT_REFRESH_AUDIENCE = 'claimflow-refresh';
const JWT_MFA_AUDIENCE = 'claimflow-mfa';

interface UserRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string | null;
  email: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  is_active: boolean;
  failed_login_count: number;
  locked_until: string | Date | null;
  last_login_at: string | Date | null;
  password_changed_at: string | Date;
  must_change_password: boolean;
}

interface MfaDeviceRow extends QueryResultRow {
  id: string;
  secret_encrypted: string;
}

interface RefreshTokenRow extends QueryResultRow {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  tenant_id: string;
  facility_id: string | null;
  role: UserRole;
  email: string;
  display_name: string;
  is_active: boolean;
}

interface PasswordHistoryRow extends QueryResultRow {
  password_hash: string;
}

interface JwtKeyMaterial {
  privateKey: string;
  publicKey: string;
  masterKey: Buffer;
}

interface AccessTokenPayload {
  sub: string;
  tenantId: string;
  facilityId: string | null;
  role: UserRole;
  type: 'access';
  sid: string;
  mfaVerifiedAt?: number;
}

interface RefreshTokenPayload {
  sub: string;
  tenantId: string;
  facilityId: string | null;
  role: UserRole;
  type: 'refresh';
  familyId: string;
  jti: string;
  mfaVerifiedAt?: number;
}

interface MfaTokenPayload {
  sub: string;
  tenantId: string;
  facilityId: string | null;
  role: UserRole;
  type: 'mfa';
}

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  facilityId: string | null;
  email: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
}

export interface LoginResult {
  requiresMfa: boolean;
  mfaToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthenticatedUser | null;
}

export interface MfaVerifyResult {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

export interface LogoutResult {
  revokedFamilyId: string;
}

export interface MfaSetupResult {
  deviceId: string;
  otpauthUrl: string;
  secret: string;
}

function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();

  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const base64Attempt = Buffer.from(trimmed, 'base64');
  if (base64Attempt.length === 32) {
    return base64Attempt;
  }

  const utf8 = Buffer.from(trimmed, 'utf8');
  if (utf8.length === 32) {
    return utf8;
  }

  throw new Error('Master key must be 32 bytes (hex, base64, or raw)');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseAccessTokenContext(payload: AccessTokenPayload, token: string): AuthContext {
  return {
    userId: payload.sub,
    tenantId: payload.tenantId,
    facilityId: payload.facilityId,
    role: payload.role,
    mfaVerifiedAt: typeof payload.mfaVerifiedAt === 'number' ? payload.mfaVerifiedAt : null,
    token,
  };
}

function decodeNoVerify(token: string): Record<string, unknown> | null {
  const parts = token.split('.');

  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1];
    if (!payload) {
      return null;
    }

    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;

    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function decodeLegacyAuthContext(token: string): AuthContext | null {
  const payload = decodeNoVerify(token);

  if (!payload) {
    return null;
  }

  const userId = typeof payload.sub === 'string' ? payload.sub : typeof payload.userId === 'string' ? payload.userId : null;
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : typeof payload.tid === 'string' ? payload.tid : null;

  if (!userId || !tenantId) {
    return null;
  }

  return {
    userId,
    tenantId,
    facilityId: typeof payload.facilityId === 'string' ? payload.facilityId : null,
    role: (typeof payload.role === 'string' ? payload.role : UserRole.CLAIMS_OFFICER) as UserRole,
    mfaVerifiedAt: typeof payload.mfaVerifiedAt === 'number' ? payload.mfaVerifiedAt : null,
    token,
  };
}

export function encryptTotpSecret(secret: string, masterKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptTotpSecret(encoded: string, masterKey: Buffer): string {
  const parts = encoded.split(':');

  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encrypted secret format');
  }

  const iv = Buffer.from(parts[1] ?? '', 'base64url');
  const tag = Buffer.from(parts[2] ?? '', 'base64url');
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');

  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export class AuthService {
  private keyMaterial: JwtKeyMaterial | null = null;
  private passwordHistoryReady = false;

  constructor(
    private readonly pool: Pool,
    private readonly logger: FastifyBaseLogger,
    private readonly config: Config,
  ) {
    authenticator.options = {
      step: 30,
      window: 1,
    };
  }

  private async loadKeys(): Promise<JwtKeyMaterial> {
    if (this.keyMaterial) {
      return this.keyMaterial;
    }

    const privatePath = resolve(this.config.KEY_PATH, 'jwt_private.pem');
    const publicPath = resolve(this.config.KEY_PATH, 'jwt_public.pem');
    const masterPath = resolve(this.config.KEY_PATH, 'master.key');

    const [privateKey, publicKey, masterKeyRaw] = await Promise.all([
      readFile(privatePath, 'utf8'),
      readFile(publicPath, 'utf8'),
      readFile(masterPath, 'utf8'),
    ]);

    this.keyMaterial = {
      privateKey,
      publicKey,
      masterKey: parseMasterKey(masterKeyRaw),
    };

    return this.keyMaterial;
  }

  private async ensurePasswordHistoryTable(): Promise<void> {
    if (this.passwordHistoryReady) {
      return;
    }

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS password_history (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         password_hash TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_password_history_user_created
         ON password_history(user_id, created_at DESC)`,
    );

    this.passwordHistoryReady = true;
  }

  private async signToken<T extends object>(payload: T, expiresIn: string, audience: string): Promise<string> {
    const { privateKey } = await this.loadKeys();

    const options: SignOptions = {
      algorithm: 'RS256',
      expiresIn: expiresIn as SignOptions['expiresIn'],
      issuer: JWT_ISSUER,
      audience,
    };

    return jwt.sign(payload, privateKey, options);
  }

  private async verifyToken(token: string, audience: string): Promise<JwtPayload> {
    try {
      const { publicKey } = await this.loadKeys();

      const verified = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: JWT_ISSUER,
        audience,
      });

      if (typeof verified === 'string') {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid token payload');
      }

      return verified;
    } catch {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid or expired token');
    }
  }

  private async createAccessToken(user: AuthenticatedUser, mfaVerifiedAt?: number): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      facilityId: user.facilityId,
      role: user.role,
      type: 'access',
      sid: randomUUID(),
      mfaVerifiedAt,
    };

    return this.signToken(payload, this.config.JWT_ACCESS_EXPIRY, JWT_ACCESS_AUDIENCE);
  }

  private async createRefreshToken(user: AuthenticatedUser, familyId: string, mfaVerifiedAt?: number): Promise<{
    token: string;
    tokenHash: string;
    expiresAt: Date;
  }> {
    const payload: RefreshTokenPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      facilityId: user.facilityId,
      role: user.role,
      type: 'refresh',
      familyId,
      jti: randomUUID(),
      mfaVerifiedAt,
    };

    const token = await this.signToken(payload, this.config.JWT_REFRESH_EXPIRY, JWT_REFRESH_AUDIENCE);
    const decoded = jwt.decode(token) as JwtPayload | null;
    const exp = decoded?.exp;

    if (!exp) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to compute refresh token expiration');
    }

    return {
      token,
      tokenHash: sha256(token),
      expiresAt: new Date(exp * 1000),
    };
  }

  private async createMfaToken(user: AuthenticatedUser): Promise<string> {
    const payload: MfaTokenPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      facilityId: user.facilityId,
      role: user.role,
      type: 'mfa',
    };

    return this.signToken(payload, '5m', JWT_MFA_AUDIENCE);
  }

  private toUser(row: UserRow): AuthenticatedUser {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      facilityId: row.facility_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: row.must_change_password,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthContext> {
    try {
      const payload = await this.verifyToken(token, JWT_ACCESS_AUDIENCE);

      if (payload.type !== 'access') {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid token type');
      }

      const typedPayload = payload as unknown as AccessTokenPayload;
      return parseAccessTokenContext(typedPayload, token);
    } catch (error) {
      if (this.config.NODE_ENV === 'test') {
        const legacy = decodeLegacyAuthContext(token);
        if (legacy) {
          return legacy;
        }
      }

      if (error instanceof DomainError) {
        throw error;
      }

      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid or expired access token');
    }
  }

  async login(params: {
    tenantId: string;
    email: string;
    password: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<LoginResult> {
    const normalizedEmail = params.email.trim().toLowerCase();

    const transactionResult = await withTransaction<
      | { kind: 'ok'; value: LoginResult }
      | { kind: 'invalid_credentials' }
    >(this.pool, async (client) => {
      const userResult = await client.query<UserRow>(
        `SELECT id, tenant_id, facility_id, email, display_name, password_hash, role, is_active,
                failed_login_count, locked_until, last_login_at, password_changed_at, must_change_password
           FROM users
          WHERE tenant_id = $1::uuid
            AND lower(email) = $2
          LIMIT 1
          FOR UPDATE`,
        [params.tenantId, normalizedEmail],
      );

      const userRow = userResult.rows[0];

      if (!userRow || !userRow.is_active) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid credentials');
      }

      const now = new Date();
      const lockedUntil = userRow.locked_until ? new Date(userRow.locked_until) : null;

      if (lockedUntil && lockedUntil > now) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Account is temporarily locked');
      }

      const passwordMatches = await bcrypt.compare(params.password, userRow.password_hash);

      if (!passwordMatches) {
        const nextFailedCount = userRow.failed_login_count + 1;
        const reachedLockout = nextFailedCount >= this.config.MAX_LOGIN_ATTEMPTS;
        const nextLockedUntil = reachedLockout
          ? new Date(now.getTime() + this.config.LOCKOUT_DURATION_MINUTES * 60_000)
          : null;

        await client.query(
          `UPDATE users
              SET failed_login_count = $3,
                  locked_until = $4,
                  updated_at = now()
            WHERE id = $1::uuid
              AND tenant_id = $2::uuid`,
          [userRow.id, userRow.tenant_id, nextFailedCount, nextLockedUntil?.toISOString() ?? null],
        );

        if (reachedLockout) {
          await client.query(
            `INSERT INTO audit_trail (
                tenant_id,
                user_id,
                action,
                detail_json,
                ip_address,
                user_agent
              ) VALUES (
                $1::uuid,
                $2::uuid,
                'USER_LOCKED'::audit_action,
                $3::jsonb,
                $4::inet,
                $5
              )`,
            [
              userRow.tenant_id,
              userRow.id,
              JSON.stringify({ reason: 'max_login_attempts', failedLoginCount: nextFailedCount }),
              params.ipAddress ?? null,
              params.userAgent ?? null,
            ],
          );
        }

        return {
          kind: 'invalid_credentials',
        };
      }

      await client.query(
        `UPDATE users
            SET failed_login_count = 0,
                locked_until = NULL,
                updated_at = now()
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid`,
        [userRow.id, userRow.tenant_id],
      );

      const mfaDeviceResult = await client.query<MfaDeviceRow>(
        `SELECT id, secret_encrypted
           FROM mfa_devices
          WHERE user_id = $1::uuid
            AND is_active = true
            AND device_type = 'TOTP'
          ORDER BY created_at DESC
          LIMIT 1`,
        [userRow.id],
      );

      const hasTotpDevice = Boolean(mfaDeviceResult.rows[0]);
      const user = this.toUser(userRow);

      if (this.config.REQUIRE_MFA || hasTotpDevice) {
        const mfaToken = await this.createMfaToken(user);

        return {
          kind: 'ok',
          value: {
            requiresMfa: true,
            mfaToken,
            accessToken: null,
            refreshToken: null,
            user: null,
          },
        };
      }

      const familyId = randomUUID();
      const mfaVerifiedAt = Date.now();
      const accessToken = await this.createAccessToken(user, mfaVerifiedAt);
      const refresh = await this.createRefreshToken(user, familyId, mfaVerifiedAt);

      await client.query(
        `INSERT INTO refresh_tokens (
            user_id,
            token_hash,
            family_id,
            expires_at
          ) VALUES (
            $1::uuid,
            $2,
            $3::uuid,
            $4::timestamptz
          )`,
        [user.id, refresh.tokenHash, familyId, refresh.expiresAt.toISOString()],
      );

      await client.query(
        `UPDATE users
            SET last_login_at = now(),
                updated_at = now()
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid`,
        [user.id, user.tenantId],
      );

      await client.query(
        `INSERT INTO audit_trail (
            tenant_id,
            user_id,
            action,
            detail_json,
            ip_address,
            user_agent
          ) VALUES (
            $1::uuid,
            $2::uuid,
            'USER_LOGIN'::audit_action,
            $3::jsonb,
            $4::inet,
            $5
          )`,
        [
          user.tenantId,
          user.id,
          JSON.stringify({ source: 'password_only' }),
          params.ipAddress ?? null,
          params.userAgent ?? null,
        ],
      );

      return {
        kind: 'ok',
        value: {
          requiresMfa: false,
          mfaToken: null,
          accessToken,
          refreshToken: refresh.token,
          user,
        },
      };
    });

    if (transactionResult.kind === 'invalid_credentials') {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid credentials');
    }

    return transactionResult.value;
  }

  async verifyMfa(params: {
    mfaToken: string;
    code: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<MfaVerifyResult> {
    const payload = await this.verifyToken(params.mfaToken, JWT_MFA_AUDIENCE);

    if (payload.type !== 'mfa') {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid MFA token type');
    }

    const typedPayload = payload as unknown as MfaTokenPayload;

    const userResult = await this.pool.query<UserRow>(
      `SELECT id, tenant_id, facility_id, email, display_name, password_hash, role, is_active,
              failed_login_count, locked_until, last_login_at, password_changed_at, must_change_password
         FROM users
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
        LIMIT 1`,
      [typedPayload.sub, typedPayload.tenantId],
    );

    const userRow = userResult.rows[0];

    if (!userRow) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'User not found for MFA verification');
    }

    const mfaDeviceResult = await this.pool.query<MfaDeviceRow>(
      `SELECT id, secret_encrypted
         FROM mfa_devices
        WHERE user_id = $1::uuid
          AND is_active = true
          AND device_type = 'TOTP'
        ORDER BY created_at DESC
        LIMIT 1`,
      [userRow.id],
    );

    const device = mfaDeviceResult.rows[0];

    if (!device) {
      throw new DomainError(ErrorCode.MFA_REQUIRED, 'No active MFA device configured');
    }

    const { masterKey } = await this.loadKeys();
    const decryptedSecret = decryptTotpSecret(device.secret_encrypted, masterKey);
    const validCode = authenticator.check(params.code, decryptedSecret);

    if (!validCode) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid MFA code');
    }

    const user = this.toUser(userRow);

    return withTransaction(this.pool, async (client) => {
      const familyId = randomUUID();
      const mfaVerifiedAt = Date.now();
      const accessToken = await this.createAccessToken(user, mfaVerifiedAt);
      const refresh = await this.createRefreshToken(user, familyId, mfaVerifiedAt);

      await client.query(
        `INSERT INTO refresh_tokens (
            user_id,
            token_hash,
            family_id,
            expires_at
          ) VALUES (
            $1::uuid,
            $2,
            $3::uuid,
            $4::timestamptz
          )`,
        [user.id, refresh.tokenHash, familyId, refresh.expiresAt.toISOString()],
      );

      await client.query(
        `UPDATE users
            SET last_login_at = now(),
                updated_at = now()
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid`,
        [user.id, user.tenantId],
      );

      await client.query(
        `UPDATE mfa_devices
            SET last_used_at = now()
          WHERE id = $1::uuid`,
        [device.id],
      );

      await client.query(
        `INSERT INTO audit_trail (
            tenant_id,
            user_id,
            action,
            detail_json,
            ip_address,
            user_agent
          ) VALUES
          (
            $1::uuid,
            $2::uuid,
            'USER_LOGIN'::audit_action,
            $3::jsonb,
            $4::inet,
            $5
          ),
          (
            $1::uuid,
            $2::uuid,
            'USER_MFA_VERIFIED'::audit_action,
            $6::jsonb,
            $4::inet,
            $5
          )`,
        [
          user.tenantId,
          user.id,
          JSON.stringify({ source: 'mfa' }),
          params.ipAddress ?? null,
          params.userAgent ?? null,
          JSON.stringify({ deviceId: device.id }),
        ],
      );

      return {
        accessToken,
        refreshToken: refresh.token,
        user,
      };
    });
  }
  async refreshSession(params: { refreshToken: string }): Promise<RefreshResult> {
    const payload = await this.verifyToken(params.refreshToken, JWT_REFRESH_AUDIENCE);

    if (payload.type !== 'refresh') {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid refresh token type');
    }

    const typedPayload = payload as unknown as RefreshTokenPayload;
    const tokenHash = sha256(params.refreshToken);

    const transactionResult = await withTransaction<
      | { kind: 'ok'; value: RefreshResult }
      | { kind: 'invalidated' }
    >(this.pool, async (client) => {
      const tokenResult = await client.query<RefreshTokenRow>(
        `SELECT rt.id, rt.user_id, rt.family_id, rt.token_hash, rt.expires_at, rt.revoked_at,
                u.tenant_id, u.facility_id, u.role, u.email, u.display_name, u.is_active
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
          LIMIT 1
          FOR UPDATE`,
        [tokenHash],
      );

      const tokenRow = tokenResult.rows[0];

      if (!tokenRow) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid refresh token');
      }

      const expired = new Date(tokenRow.expires_at) <= new Date();
      const alreadyRevoked = Boolean(tokenRow.revoked_at);

      if (alreadyRevoked || expired) {
        await client.query(
          `UPDATE refresh_tokens
              SET revoked_at = COALESCE(revoked_at, now())
            WHERE family_id = $1::uuid`,
          [tokenRow.family_id],
        );

        return {
          kind: 'invalidated',
        };
      }

      if (!tokenRow.is_active) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'User is inactive');
      }

      if (typedPayload.familyId !== tokenRow.family_id || typedPayload.sub !== tokenRow.user_id) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Refresh token payload mismatch');
      }

      await client.query(
        `UPDATE refresh_tokens
            SET revoked_at = now()
          WHERE id = $1::uuid`,
        [tokenRow.id],
      );

      const user: AuthenticatedUser = {
        id: tokenRow.user_id,
        tenantId: tokenRow.tenant_id,
        facilityId: tokenRow.facility_id,
        email: tokenRow.email,
        displayName: tokenRow.display_name,
        role: tokenRow.role,
        mustChangePassword: false,
      };

      const accessToken = await this.createAccessToken(user, typedPayload.mfaVerifiedAt);
      const refresh = await this.createRefreshToken(user, tokenRow.family_id, typedPayload.mfaVerifiedAt);

      await client.query(
        `INSERT INTO refresh_tokens (
            user_id,
            token_hash,
            family_id,
            expires_at
          ) VALUES (
            $1::uuid,
            $2,
            $3::uuid,
            $4::timestamptz
          )`,
        [user.id, refresh.tokenHash, tokenRow.family_id, refresh.expiresAt.toISOString()],
      );

      return {
        kind: 'ok',
        value: {
          accessToken,
          refreshToken: refresh.token,
          user,
        },
      };
    });

    if (transactionResult.kind === 'invalidated') {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Refresh token has been invalidated');
    }

    return transactionResult.value;
  }
  async logout(params: { refreshToken: string }): Promise<LogoutResult> {
    const payload = await this.verifyToken(params.refreshToken, JWT_REFRESH_AUDIENCE);

    if (payload.type !== 'refresh') {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid refresh token type');
    }

    const typedPayload = payload as unknown as RefreshTokenPayload;
    const tokenHash = sha256(params.refreshToken);

    return withTransaction(this.pool, async (client) => {
      const tokenResult = await client.query<RefreshTokenRow>(
        `SELECT rt.id, rt.user_id, rt.family_id, rt.token_hash, rt.expires_at, rt.revoked_at,
                u.tenant_id, u.facility_id, u.role, u.email, u.display_name, u.is_active
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1
          LIMIT 1
          FOR UPDATE`,
        [tokenHash],
      );

      const tokenRow = tokenResult.rows[0];

      if (!tokenRow) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid refresh token');
      }

      await client.query(
        `UPDATE refresh_tokens
            SET revoked_at = COALESCE(revoked_at, now())
          WHERE family_id = $1::uuid`,
        [tokenRow.family_id],
      );

      await client.query(
        `INSERT INTO audit_trail (
            tenant_id,
            user_id,
            action,
            detail_json
          ) VALUES (
            $1::uuid,
            $2::uuid,
            'USER_LOGOUT'::audit_action,
            $3::jsonb
          )`,
        [
          tokenRow.tenant_id,
          tokenRow.user_id,
          JSON.stringify({ familyId: tokenRow.family_id }),
        ],
      );

      return {
        revokedFamilyId: typedPayload.familyId,
      };
    });
  }
  async setupMfa(params: {
    userId: string;
    tenantId: string;
    email: string;
    deviceName?: string;
  }): Promise<MfaSetupResult> {
    const { masterKey } = await this.loadKeys();

    const secret = authenticator.generateSecret();
    const encrypted = encryptTotpSecret(secret, masterKey);
    const deviceName = params.deviceName?.trim() || 'Default';

    const result = await this.pool.query<MfaDeviceRow>(
      `INSERT INTO mfa_devices (
          user_id,
          device_type,
          device_name,
          secret_encrypted,
          is_active
        ) VALUES (
          $1::uuid,
          'TOTP',
          $2,
          $3,
          true
        )
        RETURNING id, secret_encrypted`,
      [params.userId, deviceName, encrypted],
    );

    const row = result.rows[0];

    if (!row) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create MFA device');
    }

    const otpauthUrl = authenticator.keyuri(params.email, 'ClaimFlow', secret);

    this.logger.info({ userId: params.userId, tenantId: params.tenantId, deviceId: row.id }, 'mfa device created');

    return {
      deviceId: row.id,
      otpauthUrl,
      secret,
    };
  }

  async changePassword(params: {
    userId: string;
    tenantId: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    await this.ensurePasswordHistoryTable();

    await withTransaction(this.pool, async (client) => {
      const userResult = await client.query<UserRow>(
        `SELECT id, tenant_id, facility_id, email, display_name, password_hash, role, is_active,
                failed_login_count, locked_until, last_login_at, password_changed_at, must_change_password
           FROM users
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid
          LIMIT 1
          FOR UPDATE`,
        [params.userId, params.tenantId],
      );

      const userRow = userResult.rows[0];

      if (!userRow) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'User not found');
      }

      const currentMatches = await bcrypt.compare(params.currentPassword, userRow.password_hash);
      if (!currentMatches) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Current password is incorrect');
      }

      if (await bcrypt.compare(params.newPassword, userRow.password_hash)) {
        throw new DomainError(ErrorCode.VALIDATION_ERROR, 'New password must be different from current password');
      }

      const history = await client.query<PasswordHistoryRow>(
        `SELECT password_hash
           FROM password_history
          WHERE user_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 5`,
        [params.userId],
      );

      for (const row of history.rows) {
        if (await bcrypt.compare(params.newPassword, row.password_hash)) {
          throw new DomainError(ErrorCode.VALIDATION_ERROR, 'New password must not match last 5 passwords');
        }
      }

      const newHash = await bcrypt.hash(params.newPassword, 12);

      await client.query(
        `INSERT INTO password_history (user_id, password_hash)
         VALUES ($1::uuid, $2)`,
        [params.userId, userRow.password_hash],
      );

      await client.query(
        `DELETE FROM password_history
          WHERE user_id = $1::uuid
            AND id NOT IN (
              SELECT id
                FROM password_history
               WHERE user_id = $1::uuid
               ORDER BY created_at DESC
               LIMIT 5
            )`,
        [params.userId],
      );

      await client.query(
        `UPDATE users
            SET password_hash = $3,
                password_changed_at = now(),
                must_change_password = false,
                updated_at = now()
          WHERE id = $1::uuid
            AND tenant_id = $2::uuid`,
        [params.userId, params.tenantId, newHash],
      );
    });
  }

  async getUserById(params: { userId: string; tenantId: string }): Promise<AuthenticatedUser> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, tenant_id, facility_id, email, display_name, password_hash, role, is_active,
              failed_login_count, locked_until, last_login_at, password_changed_at, must_change_password
         FROM users
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
          AND is_active = true
        LIMIT 1`,
      [params.userId, params.tenantId],
    );

    const row = result.rows[0];

    if (!row) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'User not found');
    }

    return this.toUser(row);
  }
}

export function createAuthService(pool: Pool, logger: FastifyBaseLogger, config: Config): AuthService {
  return new AuthService(pool, logger, config);
}











