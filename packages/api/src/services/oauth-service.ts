import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DomainError,
  ErrorCode,
  type CreateOAuthClientInput,
  type OAuthClient,
  type OAuthTokenRequestInput,
  type OAuthTokenResponse,
} from '@claimflow/shared';
import type { Pool, QueryResultRow } from 'pg';
import type { AuthService } from './auth-service.js';

interface OAuthClientRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  name: string;
  client_id: string;
  scopes: string[];
  created_by: string;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

interface VerifyRow extends OAuthClientRow {
  client_secret_hash: string;
}

const COLUMNS =
  'id, tenant_id, name, client_id, scopes, created_by, last_used_at, revoked_at, created_at';

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapClient(row: OAuthClientRow): OAuthClient {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    clientId: row.client_id,
    scopes: row.scopes,
    createdBy: row.created_by,
    lastUsedAt: toIso(row.last_used_at),
    revokedAt: toIso(row.revoked_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export interface OAuthService {
  createClient: (tenantId: string, userId: string, input: CreateOAuthClientInput) => Promise<OAuthClient>;
  listClients: (tenantId: string) => Promise<OAuthClient[]>;
  revokeClient: (tenantId: string, clientId: string) => Promise<void>;
  issueToken: (input: OAuthTokenRequestInput) => Promise<OAuthTokenResponse>;
}

export function createOAuthService(pool: Pool, authService: AuthService): OAuthService {
  return {
    async createClient(tenantId, userId, input): Promise<OAuthClient> {
      const clientId = `cfc_${randomBytes(12).toString('hex')}`;
      const clientSecret = `cfs_${randomBytes(32).toString('hex')}`;
      const secretHash = hashSecret(clientSecret);

      const result = await pool.query<OAuthClientRow>(
        `INSERT INTO oauth_clients (tenant_id, name, client_id, client_secret_hash, scopes, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5::text[], $6::uuid)
         RETURNING ${COLUMNS}`,
        [tenantId, input.name, clientId, secretHash, input.scopes, userId],
      );

      const row = result.rows[0];
      if (!row) {
        throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create OAuth client');
      }

      // Plaintext secret returned only here, never again.
      return { ...mapClient(row), clientSecret };
    },

    async listClients(tenantId): Promise<OAuthClient[]> {
      const result = await pool.query<OAuthClientRow>(
        `SELECT ${COLUMNS} FROM oauth_clients WHERE tenant_id = $1::uuid ORDER BY created_at DESC`,
        [tenantId],
      );
      return result.rows.map(mapClient);
    },

    async revokeClient(tenantId, id): Promise<void> {
      const result = await pool.query(
        `UPDATE oauth_clients SET revoked_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND revoked_at IS NULL`,
        [id, tenantId],
      );
      if (result.rowCount === 0) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'OAuth client not found or already revoked');
      }
    },

    async issueToken(input): Promise<OAuthTokenResponse> {
      // RFC 6749 §5.2: invalid client → invalid_client; we map to 401 UNAUTHORIZED.
      // Fail closed and constant-time everywhere so a bad client_id and a bad
      // secret are indistinguishable to a caller.
      const result = await pool.query<VerifyRow>(
        `SELECT ${COLUMNS}, client_secret_hash FROM oauth_clients WHERE client_id = $1`,
        [input.client_id],
      );

      const row = result.rows[0];

      // Always perform a comparison to keep timing uniform even when the client
      // is unknown or revoked.
      const candidateHash = hashSecret(input.client_secret);
      const referenceHash = row?.client_secret_hash ?? candidateHash;
      const secretOk = constantTimeEquals(candidateHash, referenceHash);

      if (!row || row.revoked_at || !secretOk) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid client credentials');
      }

      // Down-scoping: a requested scope must be a subset of the client's grant.
      const grantedScopes = new Set(row.scopes);
      const requestedScopes =
        typeof input.scope === 'string' && input.scope.trim().length > 0
          ? input.scope.trim().split(/\s+/)
          : row.scopes;

      const invalidScope = requestedScopes.find((scope) => !grantedScopes.has(scope));
      if (invalidScope) {
        throw new DomainError(ErrorCode.FORBIDDEN, `Scope not granted to client: ${invalidScope}`);
      }

      const scope = requestedScopes.join(' ');

      // Attribute machine actions to the human who provisioned the client (like
      // API keys): `sub` is the creating user so created_by FKs resolve, while
      // `cid` identifies the issuing client for audit.
      const { token, expiresIn } = await authService.signOAuthAccessToken({
        sub: row.created_by,
        tenantId: row.tenant_id,
        type: 'oauth_client',
        cid: row.client_id,
        scope,
      });

      await pool.query(`UPDATE oauth_clients SET last_used_at = now() WHERE id = $1::uuid`, [row.id]);

      return {
        access_token: token,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope,
      };
    },
  };
}
