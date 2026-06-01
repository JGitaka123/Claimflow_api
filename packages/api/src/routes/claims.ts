import fp from 'fastify-plugin';
import { DomainError, ErrorCode, ListClaimsQuerySchema, CreateClaimSchema, UpdateClaimSchema } from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { createClaimService } from '../services/claim-service.js';

const ClaimIdParamsSchema = z.object({
  claimId: z.string().uuid(),
});

const claimsRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const claimService = createClaimService(pool, fastify.log);

  fastify.post('/v1/claims', {
    preHandler: requirePermission('claim:create'),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const body = CreateClaimSchema.parse(request.body);

    const idempotencyHeader = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;

    const result = await claimService.createClaim({
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      requestId: request.id,
      body,
      idempotencyKey,
    });

    if (result.idempotentReplay) {
      reply.header('x-idempotent-replay', 'true');
    }

    reply.code(result.statusCode).send(result.payload);
  });

  fastify.get('/v1/claims', async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const query = ListClaimsQuerySchema.parse(request.query);
    const result = await claimService.listClaims({
      tenantId: request.tenant.tenantId,
      query,
    });

    reply.send({
      data: result.items,
      meta: {
        requestId: request.id,
        cursor: result.nextCursor,
        hasMore: result.hasMore,
      },
    });
  });

  fastify.get('/v1/claims/:claimId', async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);

    const result = await claimService.getClaimDetail({
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

  fastify.patch('/v1/claims/:claimId', {
    preHandler: requirePermission('claim:update'),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);
    const body = UpdateClaimSchema.parse(request.body);

    const ifMatchHeader = request.headers['if-match'];
    const ifMatchRaw = Array.isArray(ifMatchHeader) ? ifMatchHeader[0] : ifMatchHeader;

    if (!ifMatchRaw) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'If-Match header is required', {
        field: 'If-Match',
      });
    }

    const ifMatchVersion = Number.parseInt(ifMatchRaw, 10);

    if (!Number.isInteger(ifMatchVersion) || ifMatchVersion < 1) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'If-Match header must be a positive integer', {
        field: 'If-Match',
      });
    }

    const result = await claimService.updateClaim({
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      claimId,
      ifMatchVersion,
      body,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(claimsRoutes, {
  name: 'claims-routes',
});
