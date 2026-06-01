import fp from 'fastify-plugin';
import {
  CreatePreauthorizationSchema,
  DomainError,
  ErrorCode,
} from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { createPreauthorizationService } from '../services/preauthorization-service.js';

const PreauthorizationNumberParamsSchema = z.object({
  preauthNumber: z.string().min(1).max(100),
});

const ClaimIdParamsSchema = z.object({
  claimId: z.string().uuid(),
});

const preauthorizationRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const preauthorizationService = createPreauthorizationService(pool, fastify.log);

  fastify.post('/v1/preauthorizations', {
    preHandler: requirePermission('claim:update'),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const body = CreatePreauthorizationSchema.parse(request.body);
    const facilityId = body.facilityId ?? request.user.facilityId;

    if (!facilityId) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Facility is required for preauthorization', {
        field: 'facilityId',
      });
    }

    const result = await preauthorizationService.upsertPreauthorization({
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      requestId: request.id,
      body: {
        ...body,
        facilityId,
      },
    });

    reply
      .code(result.updated ? 200 : 201)
      .send({
        data: result.record,
        meta: {
          requestId: request.id,
        },
      });
  });

  fastify.get('/v1/preauthorizations/:preauthNumber', {
    preHandler: requirePermission('claim:update'),
  }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { preauthNumber } = PreauthorizationNumberParamsSchema.parse(request.params);

    const result = await preauthorizationService.getPreauthorizationByNumber({
      tenantId: request.tenant.tenantId,
      preauthNumber,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/claims/:claimId/preauthorization/validation', {
    preHandler: requirePermission('audit:trigger'),
  }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);

    const result = await preauthorizationService.validateClaimPreauthorization({
      tenantId: request.tenant.tenantId,
      claimId,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(preauthorizationRoutes, {
  name: 'preauthorization-routes',
});
