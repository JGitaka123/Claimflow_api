import fp from 'fastify-plugin';
import {
  DomainError,
  ErrorCode,
  ROLE_PERMISSIONS,
  UserRole,
  type Permission,
} from '@claimflow/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getPrivilegedPool } from '../db/privileged.js';
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
  '/v1/oauth/token',
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

/**
 * Authorize ONLY human (interactive) sessions — a JWT login, never a machine
 * credential. This gates the audit /internal endpoints that expose rule internals
 * (evidence, deterministic/ML scores, fix report): tenant staff legitimately use
 * these in the first-party web app, but an API key / OAuth client (the only thing
 * a tenant provisions for EXTERNAL integration) must never receive them. Because a
 * machine credential always sets request.apiKey, this denies every integrator
 * credential while leaving the staff dashboard working.
 */
export function requireHumanSession() {
  return async (request: FastifyRequest): Promise<void> => {
    if (request.apiKey) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'This endpoint is not available to API keys or OAuth clients');
    }
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
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

/**
 * Read the `type` claim from a JWT payload without verifying the signature, to
 * route the token to the right verifier. Verification (signature, issuer,
 * audience, expiry) is always performed afterwards by the chosen verifier.
 */
function peekTokenType(token: string): string | null {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { type?: unknown };
    return typeof decoded.type === 'string' ? decoded.type : null;
  } catch {
    return null;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  // Credential verification resolves the tenant before any request context
  // exists, so it runs on the privileged pool (allowlisted in db/privileged.ts).
  const pool = getPrivilegedPool(fastify.config);
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

    // OAuth2 client-credentials tokens are RS256 JWTs (not cf_-prefixed) carrying
    // type:'oauth_client'. They resolve tenant + scopes like an API key, and are
    // authorized by scope — never by a human role.
    if (peekTokenType(token) === 'oauth_client') {
      const { context: oauthContext, scopes, clientId } = await authService.verifyOAuthAccessToken(token);
      request.user = { ...oauthContext, role: oauthContext.role };
      request.apiKey = { id: `oauth:${clientId}`, scopes: scopes as Permission[] };
      return;
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