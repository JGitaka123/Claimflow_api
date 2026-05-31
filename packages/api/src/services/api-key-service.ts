import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError, ErrorCode, UserRole, type ApiKey, type CreateApiKeyInput, type Permission } from '@claimflow/shared';
import type { Pool, QueryResultRow } from 'pg';

interface ApiKeyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  created_by: string;
  last_used_at: string | Date | null;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

interface VerifyRow extends ApiKeyRow {
  key_hash: string;
  role: string;
  facility_id: string | null;
}

export interface VerifiedApiKey {
  keyId: string;
  tenantId: string;
  scopes: Permission[];
  createdBy: string;
  role: UserRole;
  facilityId: string | null;
}

const COLUMNS =
  'id, tenant_id, name, key_prefix, scopes, created_by, last_used_at, expires_at, revoked_at, created_at';

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    createdBy: row.created_by,
    lastUsedAt: toIso(row.last_used_at),
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

function hashKey(fullKey: string): string {
  return createHash('sha256').update(fullKey).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function normalizeRole(role: string): UserRole {
  const normalized = role.toLowerCase() as UserRole;
  return Object.values(UserRole).includes(normalized) ? normalized : UserRole.VIEWER;
}

export interface ApiKeyService {
  createApiKey: (tenantId: string, userId: string, input: CreateApiKeyInput) => Promise<ApiKey>;
  listApiKeys: (tenantId: string) => Promise<ApiKey[]>;
  revokeApiKey: (tenantId: string, keyId: string) => Promise<void>;
  verifyApiKey: (token: string) => Promise<VerifiedApiKey | null>;
}

export function createApiKeyService(pool: Pool): ApiKeyService {
  return {
    async createApiKey(tenantId, userId, input): Promise<ApiKey> {
      const prefix = randomBytes(4).toString('hex'); // 8 chars
      const secret = randomBytes(24).toString('hex');
      const fullKey = `cf_${prefix}_${secret}`;
      const keyHash = hashKey(fullKey);

      const result = await pool.query<ApiKeyRow>(
        `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5::text[], $6::uuid, $7::timestamptz)
         RETURNING ${COLUMNS}`,
        [tenantId, input.name, prefix, keyHash, input.scopes, userId, input.expiresAt ?? null],
      );

      const row = result.rows[0];
      if (!row) {
        throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create API key');
      }

      // Plaintext key returned only here, never again.
      return { ...mapApiKey(row), key: fullKey };
    },

    async listApiKeys(tenantId): Promise<ApiKey[]> {
      const result = await pool.query<ApiKeyRow>(
        `SELECT ${COLUMNS} FROM api_keys WHERE tenant_id = $1::uuid ORDER BY created_at DESC`,
        [tenantId],
      );
      return result.rows.map(mapApiKey);
    },

    async revokeApiKey(tenantId, keyId): Promise<void> {
      const result = await pool.query(
        `UPDATE api_keys SET revoked_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND revoked_at IS NULL`,
        [keyId, tenantId],
      );
      if (result.rowCount === 0) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'API key not found or already revoked');
      }
    },

    async verifyApiKey(token): Promise<VerifiedApiKey | null> {
      if (!token.startsWith('cf_')) {
        return null;
      }

      const parts = token.split('_');
      const prefix = parts[1];
      if (parts.length !== 3 || !prefix) {
        return null;
      }

      const result = await pool.query<VerifyRow>(
        `SELECT k.${COLUMNS.split(', ').join(', k.')}, k.key_hash, u.role, u.facility_id
           FROM api_keys k
           JOIN users u ON u.id = k.created_by
          WHERE k.key_prefix = $1`,
        [prefix],
      );

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      if (row.revoked_at) {
        return null;
      }
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        return null;
      }

      if (!constantTimeEquals(hashKey(token), row.key_hash)) {
        return null;
      }

      await pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1::uuid`, [row.id]);

      return {
        keyId: row.id,
        tenantId: row.tenant_id,
        scopes: row.scopes as Permission[],
        createdBy: row.created_by,
        role: normalizeRole(row.role),
        facilityId: row.facility_id,
      };
    },
  };
}
