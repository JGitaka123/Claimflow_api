import fp from 'fastify-plugin';
import {
  CreateCaseSchema,
  DomainError,
  ErrorCode,
  LinkClaimsSchema,
  ListCasesQuerySchema,
  TransitionCaseSchema,
  UpdateCaseSchema,
} from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { createCaseService } from '../services/case-service.js';

const CaseIdParamsSchema = z.object({ id: z.string().uuid() });
const CaseClaimParamsSchema = z.object({ id: z.string().uuid(), claimId: z.string().uuid() });

function requireContext(request: FastifyRequest): { tenantId: string; userId: string } {
  if (!request.tenant || !request.user) {
    throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
  }
  return { tenantId: request.tenant.tenantId, userId: request.user.userId };
}

const caseRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const caseService = createCaseService(pool, fastify.log);

  fastify.post('/v1/cases', { preHandler: requirePermission('case:manage') }, async (request, reply) => {
    const { tenantId, userId } = requireContext(request);
    const input = CreateCaseSchema.parse(request.body);
    const created = await caseService.createCase(tenantId, userId, input);
    reply.code(201).send({ data: created, meta: { requestId: request.id } });
  });

  fastify.get('/v1/cases', { preHandler: requirePermission('case:view') }, async (request, reply) => {
    const { tenantId } = requireContext(request);
    const query = ListCasesQuerySchema.parse(request.query);
    const items = await caseService.listCases(tenantId, query);
    reply.send({ data: items, meta: { requestId: request.id, total: items.length } });
  });

  fastify.get('/v1/cases/:id', { preHandler: requirePermission('case:view') }, async (request, reply) => {
    const { tenantId } = requireContext(request);
    const { id } = CaseIdParamsSchema.parse(request.params);
    const result = await caseService.getCase(tenantId, id);
    reply.send({ data: result, meta: { requestId: request.id } });
  });

  fastify.patch('/v1/cases/:id', { preHandler: requirePermission('case:manage') }, async (request, reply) => {
    const { tenantId, userId } = requireContext(request);
    const { id } = CaseIdParamsSchema.parse(request.params);
    const input = UpdateCaseSchema.parse(request.body);
    const updated = await caseService.updateCase(tenantId, userId, id, input);
    reply.send({ data: updated, meta: { requestId: request.id } });
  });

  fastify.post('/v1/cases/:id/transition', { preHandler: requirePermission('case:manage') }, async (request, reply) => {
    const { tenantId, userId } = requireContext(request);
    const { id } = CaseIdParamsSchema.parse(request.params);
    const input = TransitionCaseSchema.parse(request.body);
    const updated = await caseService.transitionCase(tenantId, userId, id, input);
    reply.send({ data: updated, meta: { requestId: request.id } });
  });

  fastify.post('/v1/cases/:id/claims', { preHandler: requirePermission('case:manage') }, async (request, reply) => {
    const { tenantId, userId } = requireContext(request);
    const { id } = CaseIdParamsSchema.parse(request.params);
    const input = LinkClaimsSchema.parse(request.body);
    const updated = await caseService.linkClaims(tenantId, userId, id, input);
    reply.send({ data: updated, meta: { requestId: request.id } });
  });

  fastify.delete('/v1/cases/:id/claims/:claimId', { preHandler: requirePermission('case:manage') }, async (request, reply) => {
    const { tenantId, userId } = requireContext(request);
    const { id, claimId } = CaseClaimParamsSchema.parse(request.params);
    await caseService.unlinkClaim(tenantId, userId, id, claimId);
    reply.code(204).send();
  });
};

export default fp(caseRoutes, {
  name: 'case-routes',
});
