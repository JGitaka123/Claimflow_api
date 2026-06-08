import {
  DomainError,
  ErrorCode,
  type BatchSubmitInput,
  type ClaimBatchAccepted,
  type ClaimBatchItem,
  type ClaimBatchStatusResult,
  type ClaimScoreResult,
} from '@claimflow/shared';
import type { PoolClient, QueryResultRow } from 'pg';
import type { TenantDb } from '../db/client.js';

interface BatchRow extends QueryResultRow {
  id: string;
  status: string;
  total_claims: number;
  processed_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

// A non-terminal batch idle longer than this is reported as stalled (worker
// crashed/expired). pg-boss retries it; this just makes the stall visible.
const STALL_THRESHOLD_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED']);

interface ItemRow extends QueryResultRow {
  item_index: number;
  status: string;
  claim_id: string | null;
  score_json: ClaimScoreResult | null;
  error_code: string | null;
  error_message: string | null;
}

function toIso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export interface SubmitBatchParams {
  tenantId: string;
  userId: string;
  input: BatchSubmitInput;
  /** Already-validated against MAX_CLAIMS_PER_BATCH by the route. */
  maxClaimsPerBatch: number;
  idempotencyKey?: string;
}

export interface CreateBatchOutcome {
  batchId: string;
  accepted: ClaimBatchAccepted;
  /** True when an Idempotency-Key replay returned an existing batch (no new job). */
  idempotentReplay: boolean;
}

export interface ClaimBatchService {
  /** Create the batch + item rows (status QUEUED) in one transaction (idempotent on Idempotency-Key). */
  createBatch: (params: SubmitBatchParams) => Promise<CreateBatchOutcome>;
  getStatus: (tenantId: string, batchId: string) => Promise<ClaimBatchStatusResult>;
}

export function createClaimBatchService(db: TenantDb): ClaimBatchService {
  return {
    async createBatch(params): Promise<CreateBatchOutcome> {
      const total = params.input.claims.length;
      if (total > params.maxClaimsPerBatch) {
        throw new DomainError(
          ErrorCode.VALIDATION_ERROR,
          `Batch exceeds the maximum of ${params.maxClaimsPerBatch} claims`,
          { field: 'claims' },
        );
      }

      // Idempotent replay: a repeat with the same Idempotency-Key returns the same
      // 202 batch response (RLS scopes the lookup to this tenant).
      if (params.idempotencyKey) {
        const replay = await db.query<{ response_body: ClaimBatchAccepted }>(
          `SELECT response_body FROM idempotency_keys
            WHERE tenant_id = $1::uuid AND idempotency_key = $2 AND expires_at > now()`,
          [params.tenantId, params.idempotencyKey],
        );
        const prior = replay.rows[0]?.response_body;
        if (prior) {
          return { batchId: prior.batchId, accepted: prior, idempotentReplay: true };
        }
      }

      return db.transaction(async (client: PoolClient) => {
        const batchInsert = await client.query<BatchRow>(
          `INSERT INTO claim_batches (tenant_id, status, total_claims, created_by)
           VALUES ($1::uuid, 'QUEUED', $2, $3::uuid)
           RETURNING id, status, total_claims, processed_count, created_at`,
          [params.tenantId, total, params.userId],
        );
        const batch = batchInsert.rows[0];
        if (!batch) {
          throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create batch');
        }

        // One QUEUED item per submitted claim. The FHIR payload itself rides on the
        // pg-boss job (not stored here) — these rows track per-item status/results.
        for (let index = 0; index < total; index += 1) {
          await client.query(
            `INSERT INTO claim_batch_items (batch_id, tenant_id, item_index, status)
             VALUES ($1::uuid, $2::uuid, $3, 'QUEUED')`,
            [batch.id, params.tenantId, index],
          );
        }

        const accepted: ClaimBatchAccepted = {
          batchId: batch.id,
          status: 'QUEUED',
          totalClaims: total,
          createdAt: toIso(batch.created_at),
        };

        if (params.idempotencyKey) {
          await client.query(
            `INSERT INTO idempotency_keys (idempotency_key, tenant_id, response_status, response_body)
             VALUES ($1, $2::uuid, 202, $3::jsonb)
             ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
            [params.idempotencyKey, params.tenantId, JSON.stringify(accepted)],
          );
        }

        return { batchId: batch.id, accepted, idempotentReplay: false };
      });
    },

    async getStatus(tenantId, batchId): Promise<ClaimBatchStatusResult> {
      const batchResult = await db.query<BatchRow>(
        `SELECT id, status, total_claims, processed_count, created_at, updated_at
           FROM claim_batches WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [batchId, tenantId],
      );
      const batch = batchResult.rows[0];
      if (!batch) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'Batch not found');
      }

      const itemsResult = await db.query<ItemRow>(
        `SELECT item_index, status, claim_id, score_json, error_code, error_message
           FROM claim_batch_items WHERE batch_id = $1::uuid AND tenant_id = $2::uuid
          ORDER BY item_index ASC`,
        [batchId, tenantId],
      );

      const items: ClaimBatchItem[] = itemsResult.rows.map((row) => ({
        index: row.item_index,
        status: row.status as ClaimBatchItem['status'],
        claimId: row.claim_id,
        score: row.score_json,
        errorCode: row.error_code,
        errorMessage: row.error_message,
      }));

      const updatedAtMs = (batch.updated_at instanceof Date ? batch.updated_at : new Date(batch.updated_at)).getTime();
      const status = batch.status as ClaimBatchStatusResult['status'];
      const stalled = !TERMINAL_STATUSES.has(status) && Date.now() - updatedAtMs > STALL_THRESHOLD_MS;

      return {
        batchId: batch.id,
        status,
        totalClaims: batch.total_claims,
        processedCount: batch.processed_count,
        createdAt: toIso(batch.created_at),
        updatedAt: toIso(batch.updated_at),
        stalled,
        items,
      };
    },
  };
}
