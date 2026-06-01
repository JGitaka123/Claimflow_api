import fp from 'fastify-plugin';
import {
  BatchAuditSchema,
  DomainError,
  ErrorCode,
  OverrideRequestSchema,
  TriggerAuditSchema,
  UserRole,
} from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { getPrivilegedPool } from '../db/privileged.js';
import { createJobQueue } from '../jobs/setup.js';
import { createAuditPipelineService } from '../workflows/audit-pipeline.js';
import { createStateMachineWorkflow } from '../workflows/state-machine.js';
import { requireRole, requireStepUpMfa } from '../plugins/auth.js';

const ClaimIdParamsSchema = z.object({
  claimId: z.string().uuid(),
});

const AuditIdParamsSchema = z.object({
  auditId: z.string().uuid(),
});

const JobIdParamsSchema = z.object({
  jobId: z.string().uuid(),
});

const OverrideApproveSchema = z.object({
  supervisorNotes: z.string().max(2000).optional(),
});

const ExportRequestSchema = z.object({
  auditSessionId: z.string().uuid().optional(),
});

function resolveLocale(acceptLanguageHeader: string | string[] | undefined): string {
  const raw = Array.isArray(acceptLanguageHeader) ? acceptLanguageHeader[0] : acceptLanguageHeader;

  if (!raw || raw.trim().length === 0) {
    return 'en';
  }

  const primary = raw.split(',')[0]?.trim().toLowerCase() ?? 'en';

  if (primary.startsWith('sw')) {
    return 'sw';
  }

  return 'en';
}

const CLAIMS_OFFICER_AND_ABOVE: UserRole[] = [
  UserRole.CLAIMS_OFFICER,
  UserRole.SUPERVISOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];

const SUPERVISOR_ADMIN_AND_ABOVE: UserRole[] = [
  UserRole.SUPERVISOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];

function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'evidence-pack.zip';
}

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const workflow = createStateMachineWorkflow(pool);
  const auditPipeline = createAuditPipelineService(pool, fastify.log, fastify.config);
  // The job queue manages pgboss + background workers (which bind their own
  // per-job tenant context), so it runs on the privileged pool.
  const jobQueue = createJobQueue(getPrivilegedPool(fastify.config), fastify.log, fastify.config);

  fastify.addHook('onClose', async () => {
    await jobQueue.stop();
  });

  fastify.post('/v1/claims/:claimId/audit', {
    preHandler: requireRole(...CLAIMS_OFFICER_AND_ABOVE),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);
    const body = TriggerAuditSchema.parse(request.body ?? {});

    const result = await auditPipeline.executeAuditPipeline({
      claimId,
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      locale: resolveLocale(request.headers['accept-language']),
      forceReprocess: body.forceReprocess,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/claims/batch-audit', {
    preHandler: requireRole(...CLAIMS_OFFICER_AND_ABOVE),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const body = BatchAuditSchema.parse(request.body ?? {});

    const hasClaimIds = Boolean(body.claimIds && body.claimIds.length > 0);
    const hasFilter = Boolean(body.filter);

    if (hasClaimIds === hasFilter) {
      throw new DomainError(
        ErrorCode.VALIDATION_ERROR,
        'Provide exactly one of claimIds or filter',
        {
          field: 'claimIds',
        },
      );
    }

    const result = await jobQueue.enqueueBatchAudit({
      tenantId: request.tenant.tenantId,
      requestedByUserId: request.user.userId,
      claimIds: body.claimIds,
      filter: body.filter,
      concurrency: body.concurrency,
    });

    reply.code(202).send({
      data: {
        jobId: result.jobId,
        totalClaims: result.totalClaims,
        status: 'QUEUED',
        createdAt: result.createdAt,
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/claims/:claimId/export', {
    preHandler: [requireRole(...CLAIMS_OFFICER_AND_ABOVE), requireStepUpMfa()],
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);
    const body = ExportRequestSchema.parse(request.body ?? {});

    const result = await jobQueue.enqueueGenerateExport({
      tenantId: request.tenant.tenantId,
      claimId,
      requestedByUserId: request.user.userId,
      auditSessionId: body.auditSessionId,
      locale: resolveLocale(request.headers['accept-language']) as 'en' | 'sw',
    });

    reply.code(202).send({
      data: {
        jobId: result.jobId,
        claimId: result.claimId,
        auditSessionId: result.auditSessionId,
        status: 'QUEUED',
        createdAt: result.createdAt,
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/jobs/:jobId', async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { jobId } = JobIdParamsSchema.parse(request.params);

    try {
      const status = await jobQueue.getBatchJobStatus(jobId, request.tenant.tenantId);

      reply.send({
        data: status,
        meta: {
          requestId: request.id,
        },
      });
      return;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== ErrorCode.NOT_FOUND) {
        throw error;
      }
    }

    const exportStatus = await jobQueue.getExportJobStatus(jobId, request.tenant.tenantId);

    reply.send({
      data: {
        ...exportStatus,
        type: 'EXPORT',
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/exports/:jobId/download', {
    preHandler: [requireRole(...CLAIMS_OFFICER_AND_ABOVE), requireStepUpMfa()],
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { jobId } = JobIdParamsSchema.parse(request.params);
    const download = await jobQueue.openExportDownload(jobId, request.tenant.tenantId);

    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${sanitizeFilename(download.outputFileName)}"`);

    return reply.send(download.stream);
  });

  fastify.get('/v1/claims/:claimId/audit/latest', async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);
    const result = await auditPipeline.getLatestAuditForClaim({
      claimId,
      tenantId: request.tenant.tenantId,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/audits/:auditId', async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { auditId } = AuditIdParamsSchema.parse(request.params);
    const result = await auditPipeline.getAuditById({
      auditId,
      tenantId: request.tenant.tenantId,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/claims/:claimId/override', {
    preHandler: requireRole(...CLAIMS_OFFICER_AND_ABOVE),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);
    const body = OverrideRequestSchema.parse(request.body);

    const claim = await workflow.requestOverride({
      claimId,
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      reason: body.reason,
    });

    reply.send({
      data: {
        claim,
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/claims/:claimId/override/approve', {
    preHandler: [requireRole(...SUPERVISOR_ADMIN_AND_ABOVE), requireStepUpMfa()],
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);
    const body = OverrideApproveSchema.parse(request.body ?? {});

    const claim = await workflow.approveOverride({
      claimId,
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      userRole: request.user.role,
      supervisorNotes: body.supervisorNotes,
    });

    reply.send({
      data: {
        claim,
      },
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(auditRoutes, {
  name: 'audit-routes',
});


