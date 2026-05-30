import fp from 'fastify-plugin';
import { DomainError, ErrorCode } from '@claimflow/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

const PUBLIC_PATHS = new Set([
  '/health',
  '/health/ready',
  '/metrics',
  '/v1/auth/login',
  '/v1/auth/mfa/verify',
  '/v1/auth/refresh',
  '/v1/auth/logout',
]);

function normalizePath(path: string): string {
  const trimmed = path.trim();

  if (trimmed.length === 0) {
    return '/';
  }

  const withoutTrailing = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  return withoutTrailing.length > 0 ? withoutTrailing : '/';
}

function getRequestPath(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? request.url ?? '/';

  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    return normalizePath(parsed.pathname);
  } catch {
    const [pathPart] = rawUrl.split('?');
    return normalizePath(pathPart ?? rawUrl);
  }
}

function isPublicPath(request: FastifyRequest): boolean {
  return PUBLIC_PATHS.has(getRequestPath(request));
}

const tenantPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorateRequest('tenant', null);

  fastify.addHook('preHandler', async (request) => {
    if (isPublicPath(request)) {
      return;
    }

    if (!request.user?.tenantId) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Tenant context missing from token');
    }

    request.tenant = {
      tenantId: request.user.tenantId,
      facilityId: request.user.facilityId,
    };
  });
};

export default fp(tenantPlugin, {
  name: 'tenant-plugin',
});