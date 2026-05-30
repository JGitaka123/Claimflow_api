import type { FastifyBaseLogger } from 'fastify';
import type { ExportService } from '../../services/export-service.js';
import type { ExportJobProgress, GenerateExportJobData } from '../types.js';

interface GenerateExportHandlerInput {
  jobId: string;
  data: GenerateExportJobData;
}

interface GenerateExportHandlerDependencies {
  logger: FastifyBaseLogger;
  exportService: ExportService;
  updateProgress: (
    jobId: string,
    updater: (progress: ExportJobProgress) => ExportJobProgress,
  ) => Promise<ExportJobProgress | null>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 500);
  }

  return 'Failed to generate evidence pack';
}

export function createGenerateExportHandler(dependencies: GenerateExportHandlerDependencies) {
  return async function handleGenerateExportJob(input: GenerateExportHandlerInput): Promise<{
    status: 'SUCCESS' | 'ERROR';
    outputPath?: string;
    outputFileName?: string;
    error?: string;
  }> {
    const { jobId, data } = input;

    await dependencies.updateProgress(jobId, (progress) => ({
      ...progress,
      status: 'PROCESSING',
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    }));

    try {
      const result = await dependencies.exportService.generateEvidencePack({
        tenantId: data.tenantId,
        claimId: data.claimId,
        auditSessionId: data.auditSessionId,
        requestedByUserId: data.requestedByUserId,
        locale: data.locale,
      });

      await dependencies.updateProgress(jobId, (progress) => ({
        ...progress,
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        outputPath: result.outputPath,
        outputFileName: result.outputFileName,
        error: null,
      }));

      return {
        status: 'SUCCESS',
        outputPath: result.outputPath,
        outputFileName: result.outputFileName,
      };
    } catch (error) {
      const message = toErrorMessage(error);

      dependencies.logger.error(
        {
          err: error,
          jobId,
          claimId: data.claimId,
          auditSessionId: data.auditSessionId,
        },
        'generate-export job failed',
      );

      await dependencies.updateProgress(jobId, (progress) => ({
        ...progress,
        status: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      }));

      return {
        status: 'ERROR',
        error: message,
      };
    }
  };
}
