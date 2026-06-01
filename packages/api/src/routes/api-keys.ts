import fp from 'fastify-plugin';
import { CreateApiKeySchema, DomainError, ErrorCode } from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getPrivilegedPool } from '../db/privileged.js';
import { requirePermission } from '../plugins/auth.js';
import { createApiKeyService } from '../services/api-key-service.js';

const ApiKeyIdParamsSchema = z.object({ id: z.string().uuid() });

const apiKeyRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPrivilegedPool(fastify.config);
  const apiKeyService = createApiKeyService(pool);

  fastify.post('/v1/api-keys', { preHandler: requirePermission('system:settings') }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    const input = CreateApiKeySchema.parse(request.body);
    const created = await apiKeyService.createApiKey(request.tenant.tenantId, request.user.userId, input);
    reply.code(201).send({ data: created, meta: { requestId: request.id } });
  });

  fastify.get('/v1/api-keys', { preHandler: requirePermission('system:settings') }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    const keys = await apiKeyService.listApiKeys(request.tenant.tenantId);
    reply.send({ data: keys, meta: { requestId: request.id, total: keys.length } });
  });

  fastify.delete('/v1/api-keys/:id', { preHandler: requirePermission('system:settings') }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    const { id } = ApiKeyIdParamsSchema.parse(request.params);
    await apiKeyService.revokeApiKey(request.tenant.tenantId, id);
    reply.code(204).send();
  });
};

export default fp(apiKeyRoutes, {
  name: 'api-key-routes',
});
