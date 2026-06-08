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
 * so every DB op is on the claimflow_app role under RLS. Each claim is scored in
 * its own try/catch — a malformed claim fails ONLY its item, never the batch.
 * Each scored claim counts toward 6d usage metering (route class `batch`).
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

    let scored = 0;
    let failed = 0;

    for (let index = 0; index < claims.length; index += 1) {
      const claim = claims[index] as ScoreClaimInput;
      try {
        const outcome = await scoring.scoreClaim({
          tenantId,
          userId: requestedByUserId,
          requestId: `${batchId}:${index}`,
          input: claim,
        });

        // Each scored claim counts toward usage metering (billing signal). Soft —
        // the worker records but does not reject; the submit endpoint is rate-limited.
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

      await deps.tenantDb.query(
        `UPDATE claim_batches SET processed_count = processed_count + 1, updated_at = now() WHERE id = $1::uuid`,
        [batchId],
      );
    }

    const finalStatus = failed === 0 ? 'COMPLETED' : scored === 0 ? 'FAILED' : 'COMPLETED_WITH_ERRORS';
    await deps.tenantDb.query(
      `UPDATE claim_batches SET status = $2, updated_at = now() WHERE id = $1::uuid`,
      [batchId, finalStatus],
    );

    return { status: finalStatus, scored, failed };
  };
}
