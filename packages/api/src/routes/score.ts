import fp from 'fastify-plugin';
import { DomainError, ErrorCode, ScoreClaimSchema } from '@claimflow/shared';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { createScoringService } from '../services/scoring-service.js';

// Public machine-facing scoring endpoint. Accepts a FHIR R4 Claim, persists the
// claim + an audit session, and returns a public-safe score (no rule internals).
// Errors are RFC 7807 problem+json (see error-handler plugin).
const scoreRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const scoringService = createScoringService(pool, fastify.log, fastify.config);

  fastify.post(
    '/v1/claims/score',
    { preHandler: requirePermission('claim:create') },
    async (request, reply) => {
      if (!request.tenant || !request.user) {
        throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
      }

      const input = ScoreClaimSchema.parse(request.body);

      const idempotencyHeader = request.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;

      const outcome = await scoringService.scoreClaim({
        tenantId: request.tenant.tenantId,
        userId: request.user.userId,
        requestId: request.id,
        input,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

      if (outcome.idempotentReplay) {
        reply.header('x-idempotent-replay', 'true');
      }

      reply.code(outcome.statusCode).send({
        data: outcome.result,
        meta: { requestId: request.id },
      });
    },
  );
};

export default fp(scoreRoutes, {
  name: 'score-routes',
});
