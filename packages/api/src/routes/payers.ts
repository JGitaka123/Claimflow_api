import fp from 'fastify-plugin';
import {
  DomainError,
  ErrorCode,
  ListPayersQuerySchema,
  PayerSlugParamSchema,
} from '@claimflow/shared';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { createPayerService } from '../services/payer-service.js';

// The payer catalog is global reference data needed by any authenticated user to
// populate the insurer dropdown when creating or auditing a claim. It is not
// tenant-scoped, so these routes require authentication (enforced globally by the
// auth plugin) but no specific RBAC permission.
const payerRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const payerService = createPayerService(pool);

  fastify.get('/v1/payers', async (request, reply) => {
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const query = ListPayersQuerySchema.parse(request.query);
    const payers = await payerService.listPayers({
      ...(query.status ? { status: query.status } : {}),
      includeInactive: query.includeInactive,
    });

    reply.send({
      data: payers,
      meta: {
        requestId: request.id,
        total: payers.length,
      },
    });
  });

  fastify.get('/v1/payers/:slug', async (request, reply) => {
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { slug } = PayerSlugParamSchema.parse(request.params);
    const payer = await payerService.getPayerBySlug(slug);

    if (!payer) {
      throw new DomainError(ErrorCode.NOT_FOUND, `Payer not found: ${slug}`);
    }

    reply.send({
      data: payer,
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(payerRoutes, {
  name: 'payer-routes',
});
