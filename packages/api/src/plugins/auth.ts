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

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const pool = getPool(fastify.config);
  const authService = createAuthService(pool, fastify.log, fastify.config);

  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request) => {
    if (isPublicPath(request)) {
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