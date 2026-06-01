import fp from 'fastify-plugin';
import { CreateWebhookEndpointSchema, DomainError, ErrorCode } from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { createWebhookService } from '../services/webhook-service.js';

const EndpointIdParamsSchema = z.object({ id: z.string().uuid() });

const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const webhookService = createWebhookService(pool, fastify.log);

  fastify.post(
    '/v1/webhooks',
    { preHandler: requirePermission('system:settings') },
    async (request, reply) => {
      if (!request.tenant) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
      }

      const input = CreateWebhookEndpointSchema.parse(request.body);
      const endpoint = await webhookService.createEndpoint(request.tenant.tenantId, input);

      reply.code(201).send({ data: endpoint, meta: { requestId: request.id } });
    },
  );

  fastify.get(
    '/v1/webhooks',
    { preHandler: requirePermission('system:settings') },
    async (request, reply) => {
      if (!request.tenant) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
      }

      const endpoints = await webhookService.listEndpoints(request.tenant.tenantId);
      reply.send({ data: endpoints, meta: { requestId: request.id, total: endpoints.length } });
    },
  );

  fastify.delete(
    '/v1/webhooks/:id',
    { preHandler: requirePermission('system:settings') },
    async (request, reply) => {
      if (!request.tenant) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
      }

      const { id } = EndpointIdParamsSchema.parse(request.params);
      await webhookService.deleteEndpoint(request.tenant.tenantId, id);
      reply.code(204).send();
    },
  );

  fastify.get(
    '/v1/webhooks/:id/deliveries',
    { preHandler: requirePermission('system:settings') },
    async (request, reply) => {
      if (!request.tenant) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
      }

      const { id } = EndpointIdParamsSchema.parse(request.params);
      const deliveries = await webhookService.listDeliveries(request.tenant.tenantId, id);
      reply.send({ data: deliveries, meta: { requestId: request.id, total: deliveries.length } });
    },
  );
};

export default fp(webhookRoutes, {
  name: 'webhook-routes',
});
