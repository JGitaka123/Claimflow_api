import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { Config } from '../config.js';

/**
 * Per-category counts for one tenant's purge run.
 *
 * The job NEVER deletes from the audit_trail itself — that table is
 * absolutely append-only (008's trigger blocks UPDATE/DELETE on all roles, and
 * rls-isolation proves this). Retention applies to operational tables only.
 */
export interface PurgeTenantSummary {
  tenantId: string;
  idempotencyKeysDeleted: number;
  claimBatchesDeleted: number;
  claimBatchItemsDeleted: number;
}

export interface PurgeRunResult {
  ranAt: string;
  windows: {
    idempotencyKeyRetentionHours: number;
    claimBatchRetentionDays: number;
  };
  perTenant: PurgeTenantSummary[];
  totalIdempotencyKeysDeleted: number;
  totalClaimBatchesDeleted: number;
  totalClaimBatchItemsDeleted: number;
}

export interface RetentionService {
  runPurgeCycle: (now?: Date) => Promise<PurgeRunResult>;
}

interface Deps {
  pool: Pool;
  config: Config;
  logger: FastifyBaseLogger;
}

const CLAIM_BATCH_TERMINAL_STATES = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] as const;

/**
 * Configurable retention purge for operational tables. Runs on the privileged
 * pool because it spans tenants in a single cycle and writes audit records on
 * each tenant's behalf; the audit_trail row is the deletion's accountability
 * record (so purges are themselves auditable).
 */
export function createRetentionService({ pool, config, logger }: Deps): RetentionService {
  return {
    async runPurgeCycle(now: Date = new Date()): Promise<PurgeRunResult> {
      const idempotencyHours = config.IDEMPOTENCY_KEY_RETENTION_HOURS;
      const batchDays = config.CLAIM_BATCH_RETENTION_DAYS;

      const idempotencyCutoff = new Date(now.getTime() - idempotencyHours * 60 * 60 * 1000);
      const batchCutoff = new Date(now.getTime() - batchDays * 24 * 60 * 60 * 1000);

      const perTenant = new Map<string, PurgeTenantSummary>();
      const ensure = (tenantId: string): PurgeTenantSummary => {
        let existing = perTenant.get(tenantId);
        if (!existing) {
          existing = {
            tenantId,
            idempotencyKeysDeleted: 0,
            claimBatchesDeleted: 0,
            claimBatchItemsDeleted: 0,
          };
          perTenant.set(tenantId, existing);
        }
        return existing;
      };

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1. idempotency_keys past their TTL (every row carries expires_at; we
        //    also enforce the retention floor from config). Tenant-scoped.
        const ikResult = await client.query<{ tenant_id: string; n: string }>(
          `WITH deleted AS (
             DELETE FROM idempotency_keys
              WHERE expires_at < $1 OR expires_at < $2
              RETURNING tenant_id
           )
           SELECT tenant_id, count(*)::text AS n FROM deleted GROUP BY tenant_id`,
          [now, idempotencyCutoff],
        );
        for (const row of ikResult.rows) {
          ensure(row.tenant_id).idempotencyKeysDeleted = Number(row.n);
        }

        // 2. claim_batches in a terminal state older than retention (items
        //    cascade-delete via the composite FK). Tenant-scoped.
        const cbResult = await client.query<{ tenant_id: string; batches: string; items: string }>(
          `WITH deleted_items AS (
             DELETE FROM claim_batch_items
              WHERE batch_id IN (
                SELECT id FROM claim_batches
                 WHERE status = ANY($1::text[])
                   AND updated_at < $2
              )
              RETURNING tenant_id
           ),
           deleted_batches AS (
             DELETE FROM claim_batches
              WHERE status = ANY($1::text[]) AND updated_at < $2
              RETURNING tenant_id
           )
           SELECT
             tid AS tenant_id,
             (SELECT count(*) FROM deleted_batches WHERE tenant_id = tid)::text AS batches,
             (SELECT count(*) FROM deleted_items   WHERE tenant_id = tid)::text AS items
           FROM (
             SELECT DISTINCT tenant_id AS tid FROM deleted_batches
             UNION
             SELECT DISTINCT tenant_id AS tid FROM deleted_items
           ) AS tenants`,
          [CLAIM_BATCH_TERMINAL_STATES, batchCutoff],
        );
        for (const row of cbResult.rows) {
          const summary = ensure(row.tenant_id);
          summary.claimBatchesDeleted = Number(row.batches);
          summary.claimBatchItemsDeleted = Number(row.items);
        }

        // 3. One immutable audit_trail row per tenant per cycle summarising the
        //    deletes. The audit_trail itself is never purged (008 trigger).
        const ranAt = now.toISOString();
        for (const summary of perTenant.values()) {
          if (
            summary.idempotencyKeysDeleted === 0 &&
            summary.claimBatchesDeleted === 0 &&
            summary.claimBatchItemsDeleted === 0
          ) {
            continue;
          }
          await insertRetentionAudit(client, summary, {
            ranAt,
            idempotencyHours,
            batchDays,
            idempotencyCutoff: idempotencyCutoff.toISOString(),
            batchCutoff: batchCutoff.toISOString(),
          });
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        logger.warn({ err }, 'retention purge cycle failed; rolled back');
        throw err;
      } finally {
        client.release();
      }

      const summaries = [...perTenant.values()];
      const total = (sel: (s: PurgeTenantSummary) => number): number =>
        summaries.reduce((acc, s) => acc + sel(s), 0);

      const result: PurgeRunResult = {
        ranAt: now.toISOString(),
        windows: {
          idempotencyKeyRetentionHours: idempotencyHours,
          claimBatchRetentionDays: batchDays,
        },
        perTenant: summaries,
        totalIdempotencyKeysDeleted: total((s) => s.idempotencyKeysDeleted),
        totalClaimBatchesDeleted: total((s) => s.claimBatchesDeleted),
        totalClaimBatchItemsDeleted: total((s) => s.claimBatchItemsDeleted),
      };

      if (summaries.length > 0) {
        logger.info(
          {
            ranAt: result.ranAt,
            tenants: summaries.length,
            idempotencyKeys: result.totalIdempotencyKeysDeleted,
            claimBatches: result.totalClaimBatchesDeleted,
            claimBatchItems: result.totalClaimBatchItemsDeleted,
          },
          'retention purge cycle complete',
        );
      }
      return result;
    },
  };
}

async function insertRetentionAudit(
  client: PoolClient,
  summary: PurgeTenantSummary,
  context: {
    ranAt: string;
    idempotencyHours: number;
    batchDays: number;
    idempotencyCutoff: string;
    batchCutoff: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_trail (tenant_id, user_id, action, detail_json)
     VALUES ($1::uuid, NULL, 'RETENTION_PURGE_RUN'::audit_action, $2::jsonb)`,
    [
      summary.tenantId,
      JSON.stringify({
        ranAt: context.ranAt,
        retentionWindows: {
          idempotencyKeyRetentionHours: context.idempotencyHours,
          claimBatchRetentionDays: context.batchDays,
        },
        cutoffs: {
          idempotencyKey: context.idempotencyCutoff,
          claimBatch: context.batchCutoff,
        },
        deleted: {
          idempotencyKeys: summary.idempotencyKeysDeleted,
          claimBatches: summary.claimBatchesDeleted,
          claimBatchItems: summary.claimBatchItemsDeleted,
        },
      }),
    ],
  );
}
