import fp from 'fastify-plugin';
import {
  CreateOAuthClientSchema,
  DomainError,
  ErrorCode,
  OAuthTokenRequestSchema,
} from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getPrivilegedPool } from '../db/privileged.js';
import { requirePermission } from '../plugins/auth.js';
import { createAuthService } from '../services/auth-service.js';
import { createOAuthService } from '../services/oauth-service.js';

const ClientIdParamsSchema = z.object({ id: z.string().uuid() });

const oauthRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPrivilegedPool(fastify.config);
  const authService = createAuthService(pool, fastify.log, fastify.config);
  const oauthService = createOAuthService(pool, authService);

  // Public OAuth2 client-credentials token endpoint (RFC 6749 §4.4). Accepts
  // application/x-www-form-urlencoded (and JSON). Errors are problem+json.
  fastify.post('/v1/oauth/token', async (request, reply) => {
    const input = OAuthTokenRequestSchema.parse(request.body);
    const token = await oauthService.issueToken(input);
    // Per RFC 6749 §5.1, token responses must not be cached.
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache').code(200).send(token);
  });

  // Admin CRUD for OAuth clients (tenant-scoped, permission system:settings).
  fastify.post('/v1/oauth/clients', { preHandler: requirePermission('system:settings') }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    const input = CreateOAuthClientSchema.parse(request.body);
    const created = await oauthService.createClient(request.tenant.tenantId, request.user.userId, input);
    reply.code(201).send({ data: created, meta: { requestId: request.id } });
  });

  fastify.get('/v1/oauth/clients', { preHandler: requirePermission('system:settings') }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    const clients = await oauthService.listClients(request.tenant.tenantId);
    reply.send({ data: clients, meta: { requestId: request.id, total: clients.length } });
  });

  fastify.delete(
    '/v1/oauth/clients/:id',
    { preHandler: requirePermission('system:settings') },
    async (request, reply) => {
      if (!request.tenant) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
      }
      const { id } = ClientIdParamsSchema.parse(request.params);
      await oauthService.revokeClient(request.tenant.tenantId, id);
      reply.code(204).send();
    },
  );
};

export default fp(oauthRoutes, {
  name: 'oauth-routes',
});
