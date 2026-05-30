import type { FastifyBaseLogger } from 'fastify';
import type { AuditPipelineService } from '../../workflows/audit-pipeline.js';
import type { BatchAuditProgress, RunAuditJobData } from '../types.js';

interface RunAuditHandlerInput {
  jobId: string;
  data: RunAuditJobData;
}

interface RunAuditHandlerDependencies {
  logger: FastifyBaseLogger;
  auditPipeline: AuditPipelineService;
  updateBatchProgress: (
    batchJobId: string,
    updater: (progress: BatchAuditProgress) => BatchAuditProgress,
  ) => Promise<BatchAuditProgress | null>;
}

function trimErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message.slice(0, 500);
  }

  return 'run-audit job failed';
}

export function createRunAuditHandler(dependencies: RunAuditHandlerDependencies) {
  return async function handleRunAuditJob(input: RunAuditHandlerInput): Promise<{
    claimId: string;
    auditSessionId: string | null;
    decision: string | null;
    status: 'SUCCESS' | 'ERROR';
    error?: string;
  }> {
    const { jobId, data } = input;

    try {
      const result = await dependencies.auditPipeline.executeAuditPipeline({
        claimId: data.claimId,
        tenantId: data.tenantId,
        userId: data.userId,
        locale: data.locale,
        forceReprocess: data.forceReprocess,
      });

      const decision = result.auditSession.decision ?? null;
      const auditSessionId = result.auditSession.id;

      if (data.batchJobId) {
        await dependencies.updateBatchProgress(data.batchJobId, (progress) => {
          const next: BatchAuditProgress = {
            ...progress,
            processedClaims: progress.processedClaims + 1,
            results: [
              ...progress.results,
              {
                claimId: data.claimId,
                auditSessionId,
                decision,
              },
            ],
          };

          if (decision === 'PASSED') {
            next.passedCount += 1;
          } else if (decision === 'FAILED') {
            next.failedCount += 1;
          } else if (decision === 'WARNING') {
            next.warningCount += 1;
          }

          return next;
        });
      }

      return {
        claimId: data.claimId,
        auditSessionId,
        decision,
        status: 'SUCCESS',
      };
    } catch (error) {
      const errorMessage = trimErrorMessage(error);

      dependencies.logger.error(
        {
          err: error,
          jobId,
          claimId: data.claimId,
          tenantId: data.tenantId,
        },
        'run-audit job failed',
      );

      if (data.batchJobId) {
        await dependencies.updateBatchProgress(data.batchJobId, (progress) => ({
          ...progress,
          processedClaims: progress.processedClaims + 1,
          errorCount: progress.errorCount + 1,
          errors: [
            ...progress.errors,
            {
              claimId: data.claimId,
              error: errorMessage,
            },
          ],
        }));
      }

      return {
        claimId: data.claimId,
        auditSessionId: null,
        decision: null,
        status: 'ERROR',
        error: errorMessage,
      };
    }
  };
}