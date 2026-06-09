export type BatchJobStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface BatchAuditFilter {
  status: 'DOCUMENTS_UPLOADED';
  facilityId?: string;
  payerId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface BatchAuditErrorItem {
  claimId: string;
  error: string;
}

export interface BatchAuditResultItem {
  claimId: string;
  auditSessionId: string | null;
  decision: string | null;
}

export interface BatchAuditProgress {
  status: BatchJobStatus;
  totalClaims: number;
  processedClaims: number;
  passedCount: number;
  failedCount: number;
  warningCount: number;
  errorCount: number;
  errors: BatchAuditErrorItem[];
  results: BatchAuditResultItem[];
  startedAt: string | null;
  completedAt: string | null;
}

export interface BatchAuditJobData {
  tenantId: string;
  requestedByUserId: string;
  claimIds?: string[];
  filter?: BatchAuditFilter;
  concurrency: number;
  progress: BatchAuditProgress;
}

export interface RunAuditJobData {
  claimId: string;
  tenantId: string;
  userId: string;
  locale: string;
  forceReprocess: boolean;
  batchJobId?: string;
}

export interface ProcessDocumentJobData {
  documentId: string;
  claimId: string;
  tenantId: string;
}

/** Async bulk claim submission (POST /v1/claims/batch). The FHIR payloads ride
 *  on the job; per-item status/results live in claim_batch_items. */
export interface ClaimBatchJobData {
  batchId: string;
  tenantId: string;
  requestedByUserId: string;
  claims: import('@claimflow/shared').BatchSubmitInput['claims'];
}

export interface ExportJobProgress {
  status: BatchJobStatus;
  startedAt: string | null;
  completedAt: string | null;
  outputPath: string | null;
  outputFileName: string | null;
  error: string | null;
}

export interface GenerateExportJobData {
  tenantId: string;
  claimId: string;
  requestedByUserId: string;
  auditSessionId: string;
  locale: 'en' | 'sw';
  progress: ExportJobProgress;
}

export interface ExportJobStatus {
  jobId: string;
  status: BatchJobStatus;
  claimId: string;
  auditSessionId: string;
  startedAt: string | null;
  completedAt: string | null;
  outputFileName: string | null;
  outputPath: string | null;
  error: string | null;
}