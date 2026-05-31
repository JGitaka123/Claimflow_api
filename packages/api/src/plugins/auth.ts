import fp from 'fastify-plugin';
import {
  DomainError,
  ErrorCode,
  ROLE_PERMISSIONS,
  UserRole,
  type Permission,
} from '@claimflow/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getPool } from '../db/client.js';
import { createAuthService } from '../services/auth-service.js';
import { createApiKeyService } from '../services/api-key-service.js';

const PUBLIC_PATHS = new Set([
  '/health',
  '/health/ready',
  '/metrics',
  '/v1/auth/login',
  '/v1/auth/mfa/verify',
  '/v1/auth/refresh',
  '/v1/auth/logout',
]);

const STEP_UP_WINDOW_MS = 5 * 60 * 1000;
const VALID_ROLES = new Set(Object.values(UserRole));

function getRequestPath(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? request.url ?? '/';
  return rawUrl.split('?')[0] ?? rawUrl;
}

function isPublicPath(request: FastifyRequest): boolean {
  return PUBLIC_PATHS.has(getRequestPath(request));
}

function normalizeRole(role: string): UserRole | null {
  const normalized = role.toLowerCase() as UserRole;
  return VALID_ROLES.has(normalized) ? normalized : null;
}

function getRoleFromRequest(request: FastifyRequest): UserRole {
  if (!request.user) {
    throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
  }

  const role = normalizeRole(request.user.role);

  if (!role) {
    throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid user role in token');
  }

  request.user.role = role;
  return role;
}

export function requireRole(...roles: UserRole[]) {
  const allowedRoles = new Set(roles);

  return async (request: FastifyRequest): Promise<void> => {
    const role = getRoleFromRequest(request);

    if (!allowedRoles.has(role)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Insufficient role privileges');
    }
  };
}

export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest): Promise<void> => {
    // Machine (API-key) requests are authorized by their explicit scopes, never by
    // the key creator's role — least privilege.
    if (request.apiKey) {
      if (!request.apiKey.scopes.includes(permission)) {
        throw new DomainError(ErrorCode.FORBIDDEN, 'API key missing required scope');
      }
      return;
    }

    const role = getRoleFromRequest(request);

    if (!ROLE_PERMISSIONS[role].includes(permission)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Missing required permission');
    }
  };
}

export function requireStepUpMfa(maxAgeMs = STEP_UP_WINDOW_MS) {
  return async (request: FastifyRequest): Promise<void> => {
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const verifiedAt = request.user.mfaVerifiedAt;

    if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt)) {
      throw new DomainError(ErrorCode.MFA_REQUIRED, 'Fresh MFA verification required');
    }

    const ageMs = Date.now() - verifiedAt;

    if (ageMs < 0 || ageMs > maxAgeMs) {
      throw new DomainError(ErrorCode.MFA_REQUIRED, 'Fresh MFA verification required');
    }
  };
}

function extractApiKeyToken(request: FastifyRequest): string | null {
  const headerKey = request.headers['x-api-key'];
  const candidate = Array.isArray(headerKey) ? headerKey[0] : headerKey;

  if (typeof candidate === 'string' && candidate.startsWith('cf_')) {
    return candidate.trim();
  }

  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer cf_')) {
    return authorization.slice('Bearer '.length).trim();
  }

  return null;
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = getPool(fastify.config);
  const authService = createAuthService(pool, fastify.log, fastify.config);
  const apiKeyService = createApiKeyService(pool);

  fastify.decorateRequest('user', null);
  fastify.decorateRequest('apiKey', null);

  fastify.addHook('onRequest', async (request) => {
    if (isPublicPath(request)) {
      return;
    }

    // Machine auth: a cf_-prefixed API key (X-Api-Key or Bearer) authenticates the
    // request and resolves tenant + scopes. The human JWT path below is unchanged.
    const apiKeyToken = extractApiKeyToken(request);
    if (apiKeyToken) {
      const verified = await apiKeyService.verifyApiKey(apiKeyToken);
      if (!verified) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid or expired API key');
      }

      request.user = {
        userId: verified.createdBy,
        tenantId: verified.tenantId,
        facilityId: verified.facilityId,
        role: verified.role,
        mfaVerifiedAt: null,
        token: apiKeyToken,
      };
      request.apiKey = { id: verified.keyId, scopes: verified.scopes };
      return;
    }

    const authorization = request.headers.authorization;

    if (!authorization || !authorization.startsWith('Bearer ')) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Missing or invalid Bearer token');
    }

    const token = authorization.slice('Bearer '.length).trim();

    if (token.length === 0) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Missing or invalid Bearer token');
    }

    const context = await authService.verifyAccessToken(token);
    const role = normalizeRole(context.role);

    if (!role) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid user role in token');
    }

    request.user = {
      ...context,
      role,
    };
  });
};

export default fp(authPlugin, {
  name: 'auth-plugin',
});