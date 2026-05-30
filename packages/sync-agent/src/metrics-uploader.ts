import { createHash } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import type { Pool, QueryResultRow } from 'pg';
import type { SyncAgentConfig } from './config.js';
import type { FacilityContext, GovernanceMode, MetricsPayload } from './types.js';

interface CountRow extends QueryResultRow {
  count: number;
}

interface KeyValueCountRow extends QueryResultRow {
  key: string;
  count: number;
}

interface AuditStatsRow extends QueryResultRow {
  total: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
}

interface RuleFailureRow extends QueryResultRow {
  rule_id: string;
  count: number;
}

interface MlStatsRow extends QueryResultRow {
  avg_ocr_confidence: number | null;
  documents_processed: number;
  manual_entry_required: number;
  errors: number;
}

interface ClaimSnapshotRow extends QueryResultRow {
  claim_id: string;
  claim_type: string;
  visit_type: string;
  amount_total: string | number;
  admission_date: Date | string;
}

interface ServiceSummaryRow extends QueryResultRow {
  code: string;
  count: number;
  total_amount: string | number;
}

function toNumber(value: string | number | null): number {
  if (value === null) {
    return 0;
  }

  return typeof value === 'number' ? value : Number.parseFloat(value);
}

function shiftDateByHash(dateValue: Date | string, hashInput: string): string {
  const source = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const hash = createHash('sha256').update(hashInput).digest();
  const offset = (hash[0] ?? 0) % 15 - 7;
  const shifted = new Date(source.getTime() + offset * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

async function resolveDiskUsagePercent(pathToMeasure: string): Promise<number | null> {
  try {
    const stats = await statfs(pathToMeasure);
    const totalBlocks = Number(stats.blocks);
    const freeBlocks = Number(stats.bfree);

    if (!Number.isFinite(totalBlocks) || totalBlocks <= 0 || !Number.isFinite(freeBlocks)) {
      return null;
    }

    const usedBlocks = Math.max(0, totalBlocks - freeBlocks);
    const percent = Number(((usedBlocks / totalBlocks) * 100).toFixed(2));

    if (!Number.isFinite(percent)) {
      return null;
    }

    return percent;
  } catch {
    return null;
  }
}

export class MetricsUploader {
  constructor(
    private readonly pool: Pool,
    private readonly config: SyncAgentConfig,
  ) {}

  async collectMetrics(input: {
    facility: FacilityContext;
    governanceMode: GovernanceMode;
    activeRulepackVersion: string;
    now?: Date;
  }): Promise<MetricsPayload> {
    const now = input.now ?? new Date();
    const from = new Date(now.getTime() - this.config.SYNC_INTERVAL_HOURS * 60 * 60 * 1000);

    const tenantId = input.facility.tenantId;

    const [
      createdClaims,
      byStatusRows,
      byTypeRows,
      auditStats,
      ruleFailures,
      mlStats,
      diskUsagePercent,
    ] = await Promise.all([
      this.pool.query<CountRow>(
        `SELECT COUNT(*)::int AS count
           FROM claims
          WHERE tenant_id = $1::uuid
            AND created_at >= $2::timestamptz
            AND created_at < $3::timestamptz`,
        [tenantId, from.toISOString(), now.toISOString()],
      ),
      this.pool.query<KeyValueCountRow>(
        `SELECT COALESCE(a.decision::text, 'UNKNOWN') AS key, COUNT(*)::int AS count
           FROM audit_sessions a
           JOIN claims c ON c.id = a.claim_id
          WHERE c.tenant_id = $1::uuid
            AND a.started_at >= $2::timestamptz
            AND a.started_at < $3::timestamptz
          GROUP BY COALESCE(a.decision::text, 'UNKNOWN')`,
        [tenantId, from.toISOString(), now.toISOString()],
      ),
      this.pool.query<KeyValueCountRow>(
        `SELECT c.claim_type::text AS key, COUNT(*)::int AS count
           FROM claims c
          WHERE c.tenant_id = $1::uuid
            AND c.created_at >= $2::timestamptz
            AND c.created_at < $3::timestamptz
          GROUP BY c.claim_type::text`,
        [tenantId, from.toISOString(), now.toISOString()],
      ),
      this.pool.query<AuditStatsRow>(
        `SELECT
            COUNT(*)::int AS total,
            COALESCE(AVG(a.execution_time_ms), 0)::float AS avg_latency_ms,
            COALESCE(
              percentile_cont(0.95) WITHIN GROUP (ORDER BY a.execution_time_ms),
              0
            )::float AS p95_latency_ms
           FROM audit_sessions a
           JOIN claims c ON c.id = a.claim_id
          WHERE c.tenant_id = $1::uuid
            AND a.started_at >= $2::timestamptz
            AND a.started_at < $3::timestamptz
            AND a.execution_time_ms IS NOT NULL`,
        [tenantId, from.toISOString(), now.toISOString()],
      ),
      this.pool.query<RuleFailureRow>(
        `SELECT rr.rule_id, COUNT(*)::int AS count
           FROM rule_results rr
           JOIN audit_sessions a ON a.id = rr.audit_session_id
           JOIN claims c ON c.id = a.claim_id
          WHERE c.tenant_id = $1::uuid
            AND rr.result = 'FAIL'::rule_result_status
            AND a.started_at >= $2::timestamptz
            AND a.started_at < $3::timestamptz
          GROUP BY rr.rule_id
          ORDER BY count DESC, rr.rule_id ASC
          LIMIT 20`,
        [tenantId, from.toISOString(), now.toISOString()],
      ),
      this.pool.query<MlStatsRow>(
        `SELECT
            COALESCE(AVG(dp.overall_confidence), 0)::float AS avg_ocr_confidence,
            COUNT(DISTINCT d.id)::int AS documents_processed,
            COUNT(*) FILTER (WHERE d.processing_status = 'MANUAL_ENTRY_REQUIRED'::doc_processing_status)::int AS manual_entry_required,
            COUNT(*) FILTER (WHERE d.processing_status = 'FAILED'::doc_processing_status)::int AS errors
           FROM documents d
           JOIN claims c ON c.id = d.claim_id
           LEFT JOIN document_pages dp ON dp.document_id = d.id
          WHERE c.tenant_id = $1::uuid
            AND d.uploaded_at >= $2::timestamptz
            AND d.uploaded_at < $3::timestamptz`,
        [tenantId, from.toISOString(), now.toISOString()],
      ),
      resolveDiskUsagePercent(this.config.STORAGE_PATH),
    ]);

    const payload: MetricsPayload = {
      facilityId: input.facility.facilityId,
      period: {
        from: from.toISOString(),
        to: now.toISOString(),
      },
      claims: {
        created: createdClaims.rows[0]?.count ?? 0,
        byStatus: Object.fromEntries(byStatusRows.rows.map((row: KeyValueCountRow) => [row.key, row.count])),
        byType: Object.fromEntries(byTypeRows.rows.map((row: KeyValueCountRow) => [row.key, row.count])),
      },
      audit: {
        total: auditStats.rows[0]?.total ?? 0,
        avgLatencyMs: Math.round(auditStats.rows[0]?.avg_latency_ms ?? 0),
        p95LatencyMs: Math.round(auditStats.rows[0]?.p95_latency_ms ?? 0),
      },
      ruleFailures: ruleFailures.rows.map((row: RuleFailureRow) => ({
        ruleId: row.rule_id,
        count: row.count,
      })),
      ml: {
        avgOcrConfidence: Number((mlStats.rows[0]?.avg_ocr_confidence ?? 0).toFixed(4)),
        documentsProcessed: mlStats.rows[0]?.documents_processed ?? 0,
        manualEntryRequired: mlStats.rows[0]?.manual_entry_required ?? 0,
        errors: mlStats.rows[0]?.errors ?? 0,
      },
      system: {
        uptime: Math.round(process.uptime()),
        diskUsagePercent,
        rupackVersion: input.activeRulepackVersion,
        rulepackVersion: input.activeRulepackVersion,
      },
    };

    if (input.governanceMode === 'DEIDENTIFIED' || input.governanceMode === 'FULL_ANALYTICS') {
      const snapshots = await this.pool.query<ClaimSnapshotRow>(
        `SELECT
            c.id::text AS claim_id,
            c.claim_type::text AS claim_type,
            c.visit_type::text AS visit_type,
            COALESCE(SUM(cl.total_amount), 0)::numeric AS amount_total,
            c.admission_date
           FROM claims c
           LEFT JOIN claim_lines cl ON cl.claim_id = c.id
          WHERE c.tenant_id = $1::uuid
            AND c.created_at >= $2::timestamptz
            AND c.created_at < $3::timestamptz
          GROUP BY c.id, c.claim_type, c.visit_type, c.admission_date
          ORDER BY c.created_at DESC
          LIMIT 100`,
        [tenantId, from.toISOString(), now.toISOString()],
      );

      payload.deidentifiedSnapshots = snapshots.rows.map((row: ClaimSnapshotRow) => ({
        claimHash: createHash('sha256').update(row.claim_id).digest('hex'),
        claimType: row.claim_type,
        visitType: row.visit_type,
        amountTotal: Number(toNumber(row.amount_total).toFixed(2)),
        dayShifted: shiftDateByHash(row.admission_date, row.claim_id),
      }));
    }

    if (input.governanceMode === 'FULL_ANALYTICS') {
      const serviceSummary = await this.pool.query<ServiceSummaryRow>(
        `SELECT
            cl.sha_service_code AS code,
            COUNT(*)::int AS count,
            COALESCE(SUM(cl.total_amount), 0)::numeric AS total_amount
           FROM claim_lines cl
           JOIN claims c ON c.id = cl.claim_id
          WHERE c.tenant_id = $1::uuid
            AND c.created_at >= $2::timestamptz
            AND c.created_at < $3::timestamptz
          GROUP BY cl.sha_service_code
          ORDER BY count DESC, total_amount DESC
          LIMIT 20`,
        [tenantId, from.toISOString(), now.toISOString()],
      );

      payload.analyticsSummary = {
        topServiceCodes: serviceSummary.rows.map((row: ServiceSummaryRow) => ({
          code: row.code,
          count: row.count,
          totalAmount: Number(toNumber(row.total_amount).toFixed(2)),
        })),
      };
    }

    return payload;
  }
}
