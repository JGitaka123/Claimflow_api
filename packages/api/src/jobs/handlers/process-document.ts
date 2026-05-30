import type { FastifyBaseLogger } from 'fastify';
import type { ProcessDocumentJobData } from '../types.js';

interface ProcessDocumentHandlerInput {
  jobId: string;
  data: ProcessDocumentJobData;
}

interface ProcessDocumentHandlerDependencies {
  logger: FastifyBaseLogger;
}

export function createProcessDocumentHandler(dependencies: ProcessDocumentHandlerDependencies) {
  return async function handleProcessDocumentJob(input: ProcessDocumentHandlerInput): Promise<{
    jobId: string;
    status: 'SKIPPED';
  }> {
    dependencies.logger.info(
      {
        jobId: input.jobId,
        documentId: input.data.documentId,
        claimId: input.data.claimId,
      },
      'process-document job received (document processing currently handled inside audit pipeline)',
    );

    return {
      jobId: input.jobId,
      status: 'SKIPPED',
    };
  };
}