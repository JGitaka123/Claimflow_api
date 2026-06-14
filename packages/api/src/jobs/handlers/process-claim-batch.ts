import { DomainError, type ScoreClaimInput } from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { TenantDb } from '../../db/client.js';
import { createScoringService } from '../../services/scoring-service.js';
import { createMeteringService } from '../../services/metering-service.js';
import type { Config } from '../../config.js';
import type { ClaimBatchJobData } from '../types.js';

interface ProcessClaimBatchInput {
  jobId: string;
  data: ClaimBatchJobData;
}

interface Deps {
  logger: FastifyBaseLogger;
  config: Config;
  /** Bound to the per-job tenant context (runWithTenant) — app role under RLS. */
  tenantDb: TenantDb;
}

const WINDOW_MS = 60_000;

/**
 * Process one async claim-submission batch. Runs inside runWithTenant(tenantId),
 * so every DB op is on the claimflow_app role under RLS.
 *
 * Durability/resumability: the worker processes only items still in QUEUED status
 * (read from the DB), so a crash/expiry + pg-boss retry RESUMES — already-SCORED
 * or FAILED items are skipped (no duplicate scoring, no double metering). The
 * terminal batch status and processed_count are recomputed from the rows, so the
 * batch always converges to a terminal state rather than stranding in PROCESSING.
 *
 * Per-item try/catch: a malformed claim fails ONLY its item, never the batch.
 * Each SUCCESSFULLY scored claim counts toward 6d usage metering (route `batch`).
 */
export function createProcessClaimBatchHandler(deps: Deps) {
  const scoring = createScoringService(deps.tenantDb, deps.logger, deps.config);
  const metering = createMeteringService(deps.tenantDb);

  return async function processClaimBatch(input: ProcessClaimBatchInput): Promise<{ status: string; scored: number; failed: number }> {
    const { batchId, tenantId, requestedByUserId, claims } = input.data;

    await deps.tenantDb.query(
      `UPDATE claim_batches SET status = 'PROCESSING', updated_at = now() WHERE id = $1::uuid`,
      [batchId],
    );

    // Resume point: only the indexes still QUEUED. On a fresh run that's all of
    // them; on a retry it's whatever hadn't reached a terminal state.
    const pending = await deps.tenantDb.query<{ item_index: number }>(
      `SELECT item_index FROM claim_batch_items
        WHERE batch_id = $1::uuid AND status = 'QUEUED'
        ORDER BY item_index ASC`,
      [batchId],
    );

    let scored = 0;
    let failed = 0;

    for (const { item_index: index } of pending.rows) {
      const claim = claims[index] as ScoreClaimInput | undefined;
      if (!claim) {
        // Defensive: a QUEUED index with no payload (shouldn't happen) — mark failed.
        await deps.tenantDb.query(
          `UPDATE claim_batch_items SET status = 'FAILED', error_code = 'INTERNAL_ERROR',
                  error_message = 'Missing claim payload', updated_at = now()
            WHERE batch_id = $1::uuid AND item_index = $2`,
          [batchId, index],
        );
        failed += 1;
        continue;
      }

      try {
        const outcome = await scoring.scoreClaim({
          tenantId,
          userId: requestedByUserId,
          requestId: `${batchId}:${index}`,
          input: claim,
        });

        // Only a SUCCESSFULLY scored claim is metered (this line is unreachable if
        // scoreClaim threw). Soft — record but never reject in the worker.
        await metering
          .recordAndCheck({
            tenantId,
            principalId: null,
            routeClass: 'batch',
            limit: deps.config.TENANT_RATE_LIMIT_RPM,
            windowMs: WINDOW_MS,
          })
          .catch((error) => deps.logger.warn({ err: error, batchId, index }, 'batch metering failed (allowing)'));

        await deps.tenantDb.query(
          `UPDATE claim_batch_items
              SET status = 'SCORED', claim_id = $3::uuid, score_json = $4::jsonb,
                  error_code = NULL, error_message = NULL, updated_at = now()
            WHERE batch_id = $1::uuid AND item_index = $2`,
          [batchId, index, outcome.result.claimId, JSON.stringify(outcome.result)],
        );
        scored += 1;
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
        const message = error instanceof Error ? error.message.slice(0, 500) : 'Failed to score claim';
        await deps.tenantDb.query(
          `UPDATE claim_batch_items
              SET status = 'FAILED', error_code = $3, error_message = $4, updated_at = now()
            WHERE batch_id = $1::uuid AND item_index = $2`,
          [batchId, index, code, message],
        );
        failed += 1;
        deps.logger.warn({ batchId, index, code }, 'batch item failed (continuing)');
      }
    }

    // Recompute progress + terminal status from the rows (retry-safe — independent
    // of how many items THIS invocation processed).
    const tally = await deps.tenantDb.query<{ total: string; terminal: string; scored: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE status IN ('SCORED','FAILED'))::text AS terminal,
              count(*) FILTER (WHERE status = 'SCORED')::text AS scored
         FROM claim_batch_items WHERE batch_id = $1::uuid`,
      [batchId],
    );
    const row = tally.rows[0];
    const total = Number(row?.total ?? 0);
    const terminal = Number(row?.terminal ?? 0);
    const scoredTotal = Number(row?.scored ?? 0);
    const allDone = terminal === total;
    const finalStatus = !allDone
      ? 'PROCESSING'
      : scoredTotal === total
        ? 'COMPLETED'
        : scoredTotal === 0
          ? 'FAILED'
          : 'COMPLETED_WITH_ERRORS';

    await deps.tenantDb.query(
      `UPDATE claim_batches SET processed_count = $2, status = $3, updated_at = now() WHERE id = $1::uuid`,
      [batchId, terminal, finalStatus],
    );

    return { status: finalStatus, scored, failed };
  };
}
