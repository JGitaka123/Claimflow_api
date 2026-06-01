import PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool, QueryResultRow } from 'pg';
import type { Readable } from 'node:stream';
import { DomainError, ErrorCode } from '@claimflow/shared';
import type { Config } from '../config.js';
import { getTenantDb, runWithTenant } from '../db/client.js';
import { createExportService } from '../services/export-service.js';
import { createWebhookService, type WebhookService } from '../services/webhook-service.js';
import { createAuditPipelineService } from '../workflows/audit-pipeline.js';

const WEBHOOK_DISPATCH_INTERVAL_MS = 30_000;
import { createBatchAuditHandler } from './handlers/batch-audit.js';
import { createGenerateExportHandler } from './handlers/generate-export.js';
import { createProcessDocumentHandler } from './handlers/process-document.js';
import { createRunAuditHandler } from './handlers/run-audit.js';
import type {
  BatchAuditFilter,
  BatchAuditJobData,
  BatchAuditProgress,
  BatchJobStatus,
  ExportJobProgress,
  ExportJobStatus,
  GenerateExportJobData,
  RunAuditJobData,
} from './types.js';

const PROCESS_DOCUMENT_JOB = 'process-document';
const RUN_AUDIT_JOB = 'run-audit';
const BATCH_AUDIT_JOB = 'batch-audit';
const GENERATE_EXPORT_JOB = 'generate-export';

const RUN_AUDIT_COMPLETION_STATES = new Set(['completed', 'failed', 'cancelled', 'expired']);

interface JobRow extends QueryResultRow {
  id: string;
  name: string;
  state: string;
  data: Record<string, unknown> | null;
  createdon: Date | string | null;
  startedon: Date | string | null;
  completedon: Date | string | null;
}

interface ClaimIdRow extends QueryResultRow {
  id: string;
}

interface TableRow extends QueryResultRow {
  table_name: string | null;
}

interface BatchAuditRequestInput {
  tenantId: string;
  requestedByUserId: string;
  claimIds?: string[];
  filter?: BatchAuditFilter;
  concurrency: number;
}

interface GenerateExportRequestInput {
  tenantId: string;
  claimId: string;
  requestedByUserId: string;
  auditSessionId?: string;
  locale: 'en' | 'sw';
}

interface BatchJobStatusPayload {
  jobId: string;
  type: 'BATCH_AUDIT';
  status: BatchJobStatus;
  totalClaims: number;
  processedClaims: number;
  passedCount: number;
  failedCount: number;
  warningCount: number;
  errorCount: number;
  errors: Array<{ claimId: string; error: string }>;
  startedAt: string | null;
  completedAt: string | null;
  results: Array<{ claimId: string; auditSessionId: string | null; decision: string | null }>;
}

interface EnqueueBatchAuditResult {
  jobId: string;
  totalClaims: number;
  createdAt: string;
}

interface EnqueueGenerateExportResult {
  jobId: string;
  claimId: string;
  auditSessionId: string;
  createdAt: string;
}

interface ExportDownloadResult {
  claimId: string;
  auditSessionId: string;
  outputFileName: string;
  stream: Readable;
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapBossStateToStatus(state: string): BatchJobStatus {
  if (state === 'created' || state === 'retry') {
    return 'QUEUED';
  }

  if (state === 'active') {
    return 'PROCESSING';
  }

  if (state === 'completed') {
    return 'COMPLETED';
  }

  if (state === 'failed' || state === 'cancelled' || state === 'expired') {
    return 'FAILED';
  }

  return 'PROCESSING';
}

function normalizeBatchProgress(input: unknown): BatchAuditProgress {
  const candidate = typeof input === 'object' && input !== null ? (input as Partial<BatchAuditProgress>) : {};

  return {
    status:
      candidate.status === 'QUEUED' ||
      candidate.status === 'PROCESSING' ||
      candidate.status === 'COMPLETED' ||
      candidate.status === 'FAILED'
        ? candidate.status
        : 'QUEUED',
    totalClaims: typeof candidate.totalClaims === 'number' ? candidate.totalClaims : 0,
    processedClaims: typeof candidate.processedClaims === 'number' ? candidate.processedClaims : 0,
    passedCount: typeof candidate.passedCount === 'number' ? candidate.passedCount : 0,
    failedCount: typeof candidate.failedCount === 'number' ? candidate.failedCount : 0,
    warningCount: typeof candidate.warningCount === 'number' ? candidate.warningCount : 0,
    errorCount: typeof candidate.errorCount === 'number' ? candidate.errorCount : 0,
    errors: Array.isArray(candidate.errors)
      ? candidate.errors
        .filter((entry): entry is { claimId: string; error: string } => {
          return Boolean(
            entry &&
              typeof (entry as { claimId?: unknown }).claimId === 'string' &&
              typeof (entry as { error?: unknown }).error === 'string',
          );
        })
      : [],
    results: Array.isArray(candidate.results)
      ? candidate.results
        .filter((entry): entry is { claimId: string; auditSessionId: string | null; decision: string | null } => {
          return Boolean(entry && typeof (entry as { claimId?: unknown }).claimId === 'string');
        })
      : [],
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : null,
    completedAt: typeof candidate.completedAt === 'string' ? candidate.completedAt : null,
  };
}

function createInitialBatchProgress(totalClaims: number): BatchAuditProgress {
  return {
    status: 'QUEUED',
    totalClaims,
    processedClaims: 0,
    passedCount: 0,
    failedCount: 0,
    warningCount: 0,
    errorCount: 0,
    errors: [],
    results: [],
    startedAt: null,
    completedAt: null,
  };
}

function normalizeExportProgress(input: unknown): ExportJobProgress {
  const candidate = typeof input === 'object' && input !== null ? (input as Partial<ExportJobProgress>) : {};

  return {
    status:
      candidate.status === 'QUEUED' ||
      candidate.status === 'PROCESSING' ||
      candidate.status === 'COMPLETED' ||
      candidate.status === 'FAILED'
        ? candidate.status
        : 'QUEUED',
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : null,
    completedAt: typeof candidate.completedAt === 'string' ? candidate.completedAt : null,
    outputPath: typeof candidate.outputPath === 'string' ? candidate.outputPath : null,
    outputFileName: typeof candidate.outputFileName === 'string' ? candidate.outputFileName : null,
    error: typeof candidate.error === 'string' ? candidate.error : null,
  };
}

function createInitialExportProgress(): ExportJobProgress {
  return {
    status: 'QUEUED',
    startedAt: null,
    completedAt: null,
    outputPath: null,
    outputFileName: null,
    error: null,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

export class JobQueueManager {
  private readonly boss: PgBoss;
  private readonly auditPipeline: ReturnType<typeof createAuditPipelineService>;
  private readonly exportService: ReturnType<typeof createExportService>;
  private readonly webhookService: WebhookService;
  private started = false;
  private workersRegistered = false;
  private webhookDispatchTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly logger: FastifyBaseLogger,
    private readonly config: Config,
  ) {
    this.boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      schema: 'pgboss',
    });

    // Tenant services run under a per-job tenant context (runWithTenant) on the
    // app-role TenantDb; the job manager's own admin queries (pgboss tables,
    // cross-tenant batch claim selection) and the webhook dispatcher use the
    // privileged pool directly.
    const tenantDb = getTenantDb(this.config);
    this.auditPipeline = createAuditPipelineService(tenantDb, this.logger, this.config);
    this.exportService = createExportService(tenantDb, this.logger, this.config);
    this.webhookService = createWebhookService(tenantDb, this.logger);
  }

  async stop(): Promise<void> {
    if (this.webhookDispatchTimer) {
      clearInterval(this.webhookDispatchTimer);
      this.webhookDispatchTimer = null;
    }

    if (!this.started) {
      return;
    }

    await this.boss.stop();
    this.started = false;
    this.workersRegistered = false;
  }

  async enqueueBatchAudit(request: BatchAuditRequestInput): Promise<EnqueueBatchAuditResult> {
    const claimIds = await this.resolveClaimIds({
      tenantId: request.tenantId,
      claimIds: request.claimIds,
      filter: request.filter,
    });

    if (claimIds.length === 0) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'No eligible claims found for batch audit');
    }

    const concurrency = Math.max(1, Math.min(8, request.concurrency || this.config.BATCH_CONCURRENCY));

    const data: BatchAuditJobData = {
      tenantId: request.tenantId,
      requestedByUserId: request.requestedByUserId,
      claimIds,
      filter: request.filter,
      concurrency,
      progress: createInitialBatchProgress(claimIds.length),
    };

    await this.ensureStarted();

    const jobId = await this.boss.send(BATCH_AUDIT_JOB, data);

    if (!jobId) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to enqueue batch-audit job');
    }

    return {
      jobId,
      totalClaims: claimIds.length,
      createdAt: new Date().toISOString(),
    };
  }

  async enqueueGenerateExport(request: GenerateExportRequestInput): Promise<EnqueueGenerateExportResult> {
    const auditSessionId = await this.exportService.ensureAuditSession({
      tenantId: request.tenantId,
      claimId: request.claimId,
      auditSessionId: request.auditSessionId,
    });

    const data: GenerateExportJobData = {
      tenantId: request.tenantId,
      claimId: request.claimId,
      requestedByUserId: request.requestedByUserId,
      auditSessionId,
      locale: request.locale,
      progress: createInitialExportProgress(),
    };

    await this.ensureStarted();

    const jobId = await this.boss.send(GENERATE_EXPORT_JOB, data);

    if (!jobId) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to enqueue generate-export job');
    }

    return {
      jobId,
      claimId: request.claimId,
      auditSessionId,
      createdAt: new Date().toISOString(),
    };
  }

  async getBatchJobStatus(jobId: string, tenantId: string): Promise<BatchJobStatusPayload> {
    await this.ensureStarted();

    const row = await this.findJobById(jobId, BATCH_AUDIT_JOB);

    if (!row) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Job not found');
    }

    const data = (row.data ?? {}) as unknown as BatchAuditJobData;

    if (data.tenantId !== tenantId) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Job not found');
    }

    const progress = normalizeBatchProgress(data.progress);

    return {
      jobId,
      type: 'BATCH_AUDIT',
      status: progress.status || mapBossStateToStatus(row.state),
      totalClaims: progress.totalClaims,
      processedClaims: progress.processedClaims,
      passedCount: progress.passedCount,
      failedCount: progress.failedCount,
      warningCount: progress.warningCount,
      errorCount: progress.errorCount,
      errors: progress.errors,
      startedAt: progress.startedAt ?? toIso(row.startedon),
      completedAt: progress.completedAt ?? toIso(row.completedon),
      results: progress.results,
    };
  }

  async getExportJobStatus(jobId: string, tenantId: string): Promise<ExportJobStatus> {
    await this.ensureStarted();

    const row = await this.findJobById(jobId, GENERATE_EXPORT_JOB);

    if (!row) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Export job not found');
    }

    const data = (row.data ?? {}) as unknown as GenerateExportJobData;

    if (data.tenantId !== tenantId) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Export job not found');
    }

    const progress = normalizeExportProgress(data.progress);

    return {
      jobId,
      claimId: data.claimId,
      auditSessionId: data.auditSessionId,
      status: progress.status || mapBossStateToStatus(row.state),
      startedAt: progress.startedAt ?? toIso(row.startedon),
      completedAt: progress.completedAt ?? toIso(row.completedon),
      outputFileName: progress.outputFileName,
      outputPath: progress.outputPath,
      error: progress.error,
    };
  }

  async openExportDownload(jobId: string, tenantId: string): Promise<ExportDownloadResult> {
    const status = await this.getExportJobStatus(jobId, tenantId);

    if (status.status !== 'COMPLETED' || !status.outputPath || !status.outputFileName) {
      throw new DomainError(ErrorCode.INVALID_STATE_TRANSITION, 'Export is not ready for download');
    }

    const stream = await this.exportService.openEvidencePackStream(status.outputPath);

    return {
      claimId: status.claimId,
      auditSessionId: status.auditSessionId,
      outputFileName: status.outputFileName,
      stream,
    };
  }

  async getBatchProgress(batchJobId: string): Promise<BatchAuditProgress | null> {
    const row = await this.findJobById(batchJobId, BATCH_AUDIT_JOB);

    if (!row) {
      return null;
    }

    const data = (row.data ?? {}) as unknown as BatchAuditJobData;
    const progress = normalizeBatchProgress(data.progress);

    return {
      ...progress,
      status: progress.status || mapBossStateToStatus(row.state),
      startedAt: progress.startedAt ?? toIso(row.startedon),
      completedAt: progress.completedAt ?? toIso(row.completedon),
    };
  }

  async updateBatchProgress(
    batchJobId: string,
    updater: (progress: BatchAuditProgress) => BatchAuditProgress,
  ): Promise<BatchAuditProgress | null> {
    const updated = await this.updateJobData(batchJobId, BATCH_AUDIT_JOB, (rawData) => {
      const currentData = rawData as unknown as BatchAuditJobData;
      const currentProgress = normalizeBatchProgress(currentData.progress);
      const nextProgress = updater(currentProgress);

      const nextData: BatchAuditJobData = {
        ...currentData,
        progress: nextProgress,
      };

      return nextData as unknown as Record<string, unknown>;
    });

    if (!updated) {
      return null;
    }

    return normalizeBatchProgress((updated as unknown as BatchAuditJobData).progress);
  }

  async updateGenerateExportProgress(
    jobId: string,
    updater: (progress: ExportJobProgress) => ExportJobProgress,
  ): Promise<ExportJobProgress | null> {
    const updated = await this.updateJobData(jobId, GENERATE_EXPORT_JOB, (rawData) => {
      const currentData = rawData as unknown as GenerateExportJobData;
      const currentProgress = normalizeExportProgress(currentData.progress);
      const nextProgress = updater(currentProgress);

      const nextData: GenerateExportJobData = {
        ...currentData,
        progress: nextProgress,
      };

      return nextData as unknown as Record<string, unknown>;
    });

    if (!updated) {
      return null;
    }

    return normalizeExportProgress((updated as unknown as GenerateExportJobData).progress);
  }

  async enqueueRunAuditJob(data: RunAuditJobData): Promise<string> {
    await this.ensureStarted();

    const jobId = await this.boss.send(RUN_AUDIT_JOB, data);

    if (!jobId) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to enqueue run-audit job');
    }

    return jobId;
  }

  async waitForRunAuditCompletion(runAuditJobId: string): Promise<void> {
    await this.ensureStarted();

    const startedAtMs = Date.now();
    const timeoutMs = Math.max(30_000, this.config.ML_TIMEOUT_MS * 4);

    while (Date.now() - startedAtMs < timeoutMs) {
      const row = await this.findJobById(runAuditJobId, RUN_AUDIT_JOB);

      if (row && RUN_AUDIT_COMPLETION_STATES.has(row.state)) {
        return;
      }

      await sleep(300);
    }

    throw new Error(`Timed out waiting for run-audit job ${runAuditJobId}`);
  }

  async resolveClaimIds(params: {
    tenantId: string;
    claimIds?: string[];
    filter?: BatchAuditFilter;
  }): Promise<string[]> {
    const claimIds = params.claimIds ?? [];

    if (claimIds.length > 0) {
      if (claimIds.length > this.config.MAX_CLAIMS_PER_BATCH) {
        throw new DomainError(ErrorCode.VALIDATION_ERROR, `claimIds exceeds max ${this.config.MAX_CLAIMS_PER_BATCH}`, {
          field: 'claimIds',
        });
      }

      const uniqueClaimIds = [...new Set(claimIds)];
      const rows = await this.pool.query<ClaimIdRow>(
        `SELECT id::text
           FROM claims
          WHERE tenant_id = $1::uuid
            AND status = 'DOCUMENTS_UPLOADED'::claim_status
            AND id = ANY($2::uuid[])
          ORDER BY created_at ASC`,
        [params.tenantId, uniqueClaimIds],
      );

      const validIds = rows.rows.map((row) => row.id);

      if (validIds.length !== uniqueClaimIds.length) {
        const validSet = new Set(validIds);
        const invalidIds = uniqueClaimIds.filter((id) => !validSet.has(id));

        throw new DomainError(
          ErrorCode.VALIDATION_ERROR,
          'Some claimIds are missing, belong to another tenant, or are not DOCUMENTS_UPLOADED',
          {
            field: 'claimIds',
            detail: {
              invalidIds,
            },
          },
        );
      }

      return validIds;
    }

    if (!params.filter) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Either claimIds or filter is required');
    }

    const whereClauses = ['tenant_id = $1::uuid', "status = 'DOCUMENTS_UPLOADED'::claim_status"];
    const values: unknown[] = [params.tenantId];
    let bindIndex = 2;

    if (params.filter.facilityId) {
      whereClauses.push(`facility_id = $${bindIndex}::uuid`);
      values.push(params.filter.facilityId);
      bindIndex += 1;
    }

    if (params.filter.payerId) {
      whereClauses.push(`payer_id = $${bindIndex}::uuid`);
      values.push(params.filter.payerId);
      bindIndex += 1;
    }

    if (params.filter.dateFrom) {
      whereClauses.push(`admission_date >= $${bindIndex}::date`);
      values.push(params.filter.dateFrom);
      bindIndex += 1;
    }

    if (params.filter.dateTo) {
      whereClauses.push(`admission_date <= $${bindIndex}::date`);
      values.push(params.filter.dateTo);
      bindIndex += 1;
    }

    values.push(this.config.MAX_CLAIMS_PER_BATCH + 1);

    const rows = await this.pool.query<ClaimIdRow>(
      `SELECT id::text
         FROM claims
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY created_at ASC
        LIMIT $${bindIndex}`,
      values,
    );

    if (rows.rows.length > this.config.MAX_CLAIMS_PER_BATCH) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, `Filter matched more than ${this.config.MAX_CLAIMS_PER_BATCH} claims`, {
        field: 'filter',
      });
    }

    return rows.rows.map((row) => row.id);
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.boss.start();
    await this.registerWorkers();
    this.startWebhookDispatcher();
    this.started = true;

    this.logger.info('pg-boss queue started');
  }

  private startWebhookDispatcher(): void {
    if (this.webhookDispatchTimer) {
      return;
    }

    this.webhookDispatchTimer = setInterval(() => {
      this.webhookService
        .dispatchDueDeliveries(this.pool)
        .catch((error) => this.logger.warn({ err: error }, 'webhook dispatch cycle failed'));
    }, WEBHOOK_DISPATCH_INTERVAL_MS);

    // Don't keep the process alive solely for webhook polling.
    this.webhookDispatchTimer.unref?.();
  }

  private async registerWorkers(): Promise<void> {
    if (this.workersRegistered) {
      return;
    }

    const processDocumentHandler = createProcessDocumentHandler({
      logger: this.logger,
    });

    const runAuditHandler = createRunAuditHandler({
      logger: this.logger,
      auditPipeline: this.auditPipeline,
      updateBatchProgress: this.updateBatchProgress.bind(this),
    });

    const batchAuditHandler = createBatchAuditHandler({
      logger: this.logger,
      defaultConcurrency: this.config.BATCH_CONCURRENCY,
      resolveClaimIds: this.resolveClaimIds.bind(this),
      enqueueRunAuditJob: this.enqueueRunAuditJob.bind(this),
      waitForRunAuditCompletion: this.waitForRunAuditCompletion.bind(this),
      updateBatchProgress: this.updateBatchProgress.bind(this),
      getBatchProgress: this.getBatchProgress.bind(this),
    });

    const generateExportHandler = createGenerateExportHandler({
      logger: this.logger,
      exportService: this.exportService,
      updateProgress: this.updateGenerateExportProgress.bind(this),
    });

    await this.boss.work(PROCESS_DOCUMENT_JOB, async (job) => {
      const payload = (job?.data ?? {}) as {
        documentId?: string;
        claimId?: string;
        tenantId?: string;
      };

      if (!payload.documentId || !payload.claimId || !payload.tenantId) {
        return {
          status: 'SKIPPED',
          reason: 'invalid_job_payload',
        };
      }

      const { documentId, claimId, tenantId } = payload;
      // Bind the job's tenant so the handler's tenant-scoped queries run under RLS.
      return runWithTenant(tenantId, () =>
        processDocumentHandler({
          jobId: job.id,
          data: { documentId, claimId, tenantId },
        }),
      );
    });

    await this.boss.work(RUN_AUDIT_JOB, async (job) => {
      const data = job.data as RunAuditJobData;
      return runWithTenant(data.tenantId, () => runAuditHandler({ jobId: job.id, data }));
    });

    await this.boss.work(BATCH_AUDIT_JOB, async (job) => {
      const data = job.data as BatchAuditJobData;
      return runWithTenant(data.tenantId, () => batchAuditHandler({ jobId: job.id, data }));
    });

    await this.boss.work(GENERATE_EXPORT_JOB, async (job) => {
      const data = job.data as GenerateExportJobData;
      return runWithTenant(data.tenantId, () => generateExportHandler({ jobId: job.id, data }));
    });

    this.workersRegistered = true;
  }

  private async updateJobData(
    jobId: string,
    jobName: string,
    updater: (data: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    await this.ensureStarted();

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const rowResult = await client.query<JobRow>(
        `SELECT
            id::text,
            name,
            state,
            data,
            createdon,
            startedon,
            completedon
          FROM pgboss.job
         WHERE id = $1::uuid
           AND name = $2
         FOR UPDATE`,
        [jobId, jobName],
      );

      const row = rowResult.rows[0];

      if (!row) {
        await client.query('COMMIT');
        return null;
      }

      const currentData = row.data ?? {};
      const nextData = updater(currentData);

      await client.query(
        `UPDATE pgboss.job
            SET data = $2::jsonb
          WHERE id = $1::uuid`,
        [jobId, JSON.stringify(nextData)],
      );

      await client.query('COMMIT');
      return nextData;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findJobById(jobId: string, jobName: string): Promise<JobRow | null> {
    const activeResult = await this.pool.query<JobRow>(
      `SELECT
          id::text,
          name,
          state,
          data,
          createdon,
          startedon,
          completedon
        FROM pgboss.job
       WHERE id = $1::uuid
         AND name = $2
       LIMIT 1`,
      [jobId, jobName],
    );

    const activeRow = activeResult.rows[0];

    if (activeRow) {
      return activeRow;
    }

    const tableResult = await this.pool.query<TableRow>(`SELECT to_regclass('pgboss.archive')::text AS table_name`);

    if (!tableResult.rows[0]?.table_name) {
      return null;
    }

    const archiveResult = await this.pool.query<JobRow>(
      `SELECT
          id::text,
          name,
          state,
          data,
          createdon,
          startedon,
          completedon
        FROM pgboss.archive
       WHERE id = $1::uuid
         AND name = $2
       LIMIT 1`,
      [jobId, jobName],
    );

    return archiveResult.rows[0] ?? null;
  }
}

export function createJobQueue(pool: Pool, logger: FastifyBaseLogger, config: Config): JobQueueManager {
  return new JobQueueManager(pool, logger, config);
}
