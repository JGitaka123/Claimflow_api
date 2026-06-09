import fp from 'fastify-plugin';
import { BatchSubmitSchema, DomainError, ErrorCode } from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { getPrivilegedPool } from '../db/privileged.js';
import { requirePermission } from '../plugins/auth.js';
import { createClaimBatchService } from '../services/claim-batch-service.js';
import { createJobQueue } from '../jobs/setup.js';

const BatchIdParamsSchema = z.object({ batchId: z.string().uuid() });

// Async bulk submit + score. POST returns a batch id immediately (202); the
// worker scores each claim under runWithTenant (app role, RLS). Per-claim results
// surface via the claim.flagged webhook and GET /v1/claims/batch/:batchId.
const claimsBatchRoutes: FastifyPluginAsync = async (fastify) => {
  const db = getTenantDb(fastify.config);
  const batchService = createClaimBatchService(db);
  // The job queue runs background workers (which bind their own per-job tenant
  // context), so it uses the privileged pool.
  const jobQueue = createJobQueue(getPrivilegedPool(fastify.config), fastify.log, fastify.config);

  fastify.addHook('onClose', async () => {
    await jobQueue.stop();
  });

  fastify.post('/v1/claims/batch', {
    preHandler: requirePermission('claim:create'),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const input = BatchSubmitSchema.parse(request.body);

    const idempotencyHeader = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;

    const outcome = await batchService.createBatch({
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      input,
      maxClaimsPerBatch: fastify.config.MAX_CLAIMS_PER_BATCH,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    // Dispatch the worker only for a freshly-created batch (a replay already has one).
    if (!outcome.idempotentReplay) {
      await jobQueue.enqueueClaimBatch({
        batchId: outcome.batchId,
        tenantId: request.tenant.tenantId,
        requestedByUserId: request.user.userId,
        claims: input.claims,
      });
    } else {
      reply.header('x-idempotent-replay', 'true');
    }

    reply.code(202).send({ data: outcome.accepted, meta: { requestId: request.id } });
  });

  fastify.get('/v1/claims/batch/:batchId', {
    preHandler: requirePermission('claim:create'),
  }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    const { batchId } = BatchIdParamsSchema.parse(request.params);
    const status = await batchService.getStatus(request.tenant.tenantId, batchId);
    reply.send({ data: status, meta: { requestId: request.id } });
  });
};

export default fp(claimsBatchRoutes, {
  name: 'claims-batch-routes',
});
