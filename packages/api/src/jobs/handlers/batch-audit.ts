import type { FastifyBaseLogger } from 'fastify';
import type { BatchAuditJobData, BatchAuditProgress, RunAuditJobData } from '../types.js';

interface BatchAuditHandlerInput {
  jobId: string;
  data: BatchAuditJobData;
}

interface BatchAuditHandlerDependencies {
  logger: FastifyBaseLogger;
  defaultConcurrency: number;
  resolveClaimIds: (params: {
    tenantId: string;
    claimIds?: string[];
    filter?: BatchAuditJobData['filter'];
  }) => Promise<string[]>;
  enqueueRunAuditJob: (data: RunAuditJobData) => Promise<string>;
  waitForRunAuditCompletion: (jobId: string) => Promise<void>;
  updateBatchProgress: (
    batchJobId: string,
    updater: (progress: BatchAuditProgress) => BatchAuditProgress,
  ) => Promise<BatchAuditProgress | null>;
  getBatchProgress: (batchJobId: string) => Promise<BatchAuditProgress | null>;
}

function clampConcurrency(value: number, fallback: number): number {
  if (!Number.isInteger(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(8, value));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;

  const runners = Array.from({ length: effectiveConcurrency }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      const item = items[currentIndex];

      if (!item) {
        continue;
      }

      await worker(item);
    }
  });

  await Promise.all(runners);
}

export function createBatchAuditHandler(dependencies: BatchAuditHandlerDependencies) {
  return async function handleBatchAuditJob(input: BatchAuditHandlerInput): Promise<BatchAuditProgress> {
    const { jobId, data } = input;
    const startedAt = new Date().toISOString();

    await dependencies.updateBatchProgress(jobId, (progress) => ({
      ...progress,
      status: 'PROCESSING',
      startedAt,
      completedAt: null,
    }));

    const claimIds = data.claimIds && data.claimIds.length > 0
      ? data.claimIds
      : await dependencies.resolveClaimIds({
        tenantId: data.tenantId,
        claimIds: data.claimIds,
        filter: data.filter,
      });

    if (claimIds.length === 0) {
      const completedAt = new Date().toISOString();

      const progress = await dependencies.updateBatchProgress(jobId, (current) => ({
        ...current,
        status: 'FAILED',
        totalClaims: 0,
        processedClaims: 0,
        errorCount: current.errorCount + 1,
        errors: [
          ...current.errors,
          {
            claimId: 'BATCH',
            error: 'No eligible claims found for batch audit',
          },
        ],
        completedAt,
      }));

      return progress ?? {
        ...data.progress,
        status: 'FAILED',
        startedAt,
        completedAt,
      };
    }

    await dependencies.updateBatchProgress(jobId, (progress) => ({
      ...progress,
      totalClaims: claimIds.length,
    }));

    const concurrency = clampConcurrency(data.concurrency, dependencies.defaultConcurrency);

    await runWithConcurrency(claimIds, concurrency, async (claimId) => {
      try {
        const runAuditJobId = await dependencies.enqueueRunAuditJob({
          claimId,
          tenantId: data.tenantId,
          userId: data.requestedByUserId,
          locale: 'en',
          forceReprocess: false,
          batchJobId: jobId,
        });

        await dependencies.waitForRunAuditCompletion(runAuditJobId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to enqueue or monitor run-audit job';

        dependencies.logger.error(
          {
            err: error,
            batchJobId: jobId,
            claimId,
          },
          'batch-audit orchestration error',
        );

        await dependencies.updateBatchProgress(jobId, (progress) => ({
          ...progress,
          processedClaims: progress.processedClaims + 1,
          errorCount: progress.errorCount + 1,
          errors: [
            ...progress.errors,
            {
              claimId,
              error: message.slice(0, 500),
            },
          ],
        }));
      }
    });

    const completedAt = new Date().toISOString();
    const finalProgress = await dependencies.updateBatchProgress(jobId, (progress) => ({
      ...progress,
      status: progress.errorCount > 0 && progress.processedClaims === 0 ? 'FAILED' : 'COMPLETED',
      completedAt,
    }));

    if (!finalProgress) {
      const fallback = await dependencies.getBatchProgress(jobId);

      if (fallback) {
        return fallback;
      }

      return {
        ...data.progress,
        status: 'FAILED',
        totalClaims: claimIds.length,
        completedAt,
      };
    }

    return finalProgress;
  };
}