import fp from 'fastify-plugin';
import { DomainError, ErrorCode } from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { QueryResultRow } from 'pg';
import { getPool } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { isMlServiceExposedHost } from '../integrations/ml-network.js';

const PeriodSchema = z.enum(['7d', '30d', '90d']);

const TopFailuresQuerySchema = z.object({
  period: PeriodSchema.default('30d'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PeriodOnlyQuerySchema = z.object({
  period: PeriodSchema.default('30d'),
});

interface CountRow extends QueryResultRow {
  count: number;
}

interface ClaimsStatusRow extends QueryResultRow {
  status: string;
  count: number;
}

interface ClaimsTypeRow extends QueryResultRow {
  type: string;
  count: number;
}

interface TrendRow extends QueryResultRow {
  day: Date | string;
  passed: number;
  failed: number;
  warning: number;
}

interface AuditStatsRow extends QueryResultRow {
  avg_latency_ms: number | null;
  pass_rate: number | null;
}

interface DocumentStatsRow extends QueryResultRow {
  total_docs: number;
  completed_docs: number;
  failed_docs: number;
}

interface OcrStatsRow extends QueryResultRow {
  avg_ocr_confidence: number | null;
}

interface QueueTableRow extends QueryResultRow {
  table_name: string | null;
}

interface QueueDepthRow extends QueryResultRow {
  depth: number;
}

interface TopFailureRow extends QueryResultRow {
  rule_id: string;
  failures: number;
  affected_claims: number;
}

interface PreviousTopFailureRow extends QueryResultRow {
  rule_id: string;
  failures: number;
}

interface ProductivityRow extends QueryResultRow {
  user_id: string;
  display_name: string;
  role: string;
  claims_audited: number;
  avg_audit_time_ms: number | null;
  corrections_count: number;
}

interface DocumentQualityRow extends QueryResultRow {
  doc_type: string;
  documents_count: number;
  avg_ocr_confidence: number | null;
  manual_entry_rate: number | null;
}

interface MlHealthResult {
  status: 'HEALTHY' | 'DEGRADED';
  latencyMs: number | null;
}

function periodToDays(period: z.infer<typeof PeriodSchema>): number {
  if (period === '7d') {
    return 7;
  }

  if (period === '90d') {
    return 90;
  }

  return 30;
}

function toDateString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

async function checkMlHealth(baseUrl: string, timeoutMs: number, nodeEnv: string): Promise<MlHealthResult> {
  if (nodeEnv === 'production' && isMlServiceExposedHost(baseUrl)) {
    return {
      status: 'DEGRADED',
      latencyMs: null,
    };
  }

  const controller = new AbortController();
  const effectiveTimeoutMs = Math.min(Math.max(timeoutMs, 1000), 5000);
  const timeoutHandle = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        status: 'DEGRADED',
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      status: 'HEALTHY',
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      status: 'DEGRADED',
      latencyMs: null,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveQueueDepth(pool: ReturnType<typeof getPool>): Promise<number> {

  try {
    const tableResult = await pool.query<QueueTableRow>(
      `SELECT to_regclass('pgboss.job') AS table_name`,
    );

    const tableName = tableResult.rows[0]?.table_name;

    if (!tableName) {
      return 0;
    }

    const depthResult = await pool.query<QueueDepthRow>(
      `SELECT COUNT(*)::int AS depth
         FROM pgboss.job
        WHERE state IN ('created', 'retry', 'active')`,
    );

    return depthResult.rows[0]?.depth ?? 0;
  } catch {
    return 0;
  }
}

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool(fastify.config);


  fastify.get('/v1/dashboard/overview', { preHandler: requirePermission('dashboard:view') }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const tenantId = request.tenant.tenantId;

    const [
      claimsTodayResult,
      claimsWeekResult,
      pendingAuditResult,
      auditStatsResult,
      trendResult,
      claimsByTypeResult,
      claimsByStatusResult,
      documentStatsResult,
      ocrStatsResult,
      queueDepth,
      mlHealth,
    ] = await Promise.all([
      pool.query<CountRow>(
        `SELECT COUNT(*)::int AS count
           FROM claims
          WHERE tenant_id = $1::uuid
            AND created_at >= date_trunc('day', now())`,
        [tenantId],
      ),
      pool.query<CountRow>(
        `SELECT COUNT(*)::int AS count
           FROM claims
          WHERE tenant_id = $1::uuid
            AND created_at >= date_trunc('week', now())`,
        [tenantId],
      ),
      pool.query<CountRow>(
        `SELECT COUNT(*)::int AS count
           FROM claims
          WHERE tenant_id = $1::uuid
            AND status IN (
              'DOCUMENTS_UPLOADED'::claim_status,
              'CORRECTIONS_IN_PROGRESS'::claim_status,
              'PROCESSING'::claim_status
            )`,
        [tenantId],
      ),
      pool.query<AuditStatsRow>(
        `SELECT
            COALESCE(AVG(a.execution_time_ms), 0)::float AS avg_latency_ms,
            CASE
              WHEN COUNT(*) = 0 THEN 0
              ELSE ROUND(
                100.0 * SUM(CASE WHEN a.decision = 'PASSED'::audit_decision THEN 1 ELSE 0 END) / COUNT(*),
                2
              )
            END AS pass_rate
           FROM audit_sessions a
           JOIN claims c ON c.id = a.claim_id
          WHERE c.tenant_id = $1::uuid
            AND a.started_at >= date_trunc('month', now())`,
        [tenantId],
      ),
      pool.query<TrendRow>(
        `SELECT
            series.day::date AS day,
            COALESCE(
              SUM(CASE WHEN c.tenant_id = $1::uuid AND a.decision = 'PASSED'::audit_decision THEN 1 ELSE 0 END),
              0
            )::int AS passed,
            COALESCE(
              SUM(CASE WHEN c.tenant_id = $1::uuid AND a.decision = 'FAILED'::audit_decision THEN 1 ELSE 0 END),
              0
            )::int AS failed,
            COALESCE(
              SUM(CASE WHEN c.tenant_id = $1::uuid AND a.decision = 'WARNING'::audit_decision THEN 1 ELSE 0 END),
              0
            )::int AS warning
           FROM generate_series(current_date - INTERVAL '29 days', current_date, INTERVAL '1 day') AS series(day)
           LEFT JOIN audit_sessions a
             ON a.started_at >= series.day
            AND a.started_at < series.day + INTERVAL '1 day'
           LEFT JOIN claims c ON c.id = a.claim_id
           GROUP BY series.day
           ORDER BY series.day`,
        [tenantId],
      ),
      pool.query<ClaimsTypeRow>(
        `SELECT
            claim_type::text AS type,
            COUNT(*)::int AS count
           FROM claims
          WHERE tenant_id = $1::uuid
            AND created_at >= date_trunc('month', now())
          GROUP BY claim_type
          ORDER BY count DESC, type ASC`,
        [tenantId],
      ),
      pool.query<ClaimsStatusRow>(
        `SELECT
            status::text AS status,
            COUNT(*)::int AS count
           FROM claims
          WHERE tenant_id = $1::uuid
            AND created_at >= date_trunc('month', now())
          GROUP BY status
          ORDER BY count DESC, status ASC`,
        [tenantId],
      ),
      pool.query<DocumentStatsRow>(
        `SELECT
            COUNT(*)::int AS total_docs,
            COUNT(*) FILTER (WHERE d.processing_status = 'COMPLETED'::doc_processing_status)::int AS completed_docs,
            COUNT(*) FILTER (WHERE d.processing_status = 'FAILED'::doc_processing_status)::int AS failed_docs
           FROM documents d
           JOIN claims c ON c.id = d.claim_id
          WHERE c.tenant_id = $1::uuid
            AND d.uploaded_at >= date_trunc('month', now())`,
        [tenantId],
      ),
      pool.query<OcrStatsRow>(
        `SELECT
            COALESCE(AVG(dp.overall_confidence), 0)::float AS avg_ocr_confidence
           FROM document_pages dp
           JOIN documents d ON d.id = dp.document_id
           JOIN claims c ON c.id = d.claim_id
          WHERE c.tenant_id = $1::uuid
            AND d.uploaded_at >= date_trunc('month', now())
            AND dp.overall_confidence IS NOT NULL`,
        [tenantId],
      ),
      resolveQueueDepth(pool),
      checkMlHealth(fastify.config.ML_SERVICE_URL, fastify.config.ML_TIMEOUT_MS, fastify.config.NODE_ENV),
    ]);

    const auditStats = auditStatsResult.rows[0];
    const documentStats = documentStatsResult.rows[0];
    const ocrStats = ocrStatsResult.rows[0];

    reply.send({
      data: {
        claimsToday: claimsTodayResult.rows[0]?.count ?? 0,
        claimsThisWeek: claimsWeekResult.rows[0]?.count ?? 0,
        pendingAudit: pendingAuditResult.rows[0]?.count ?? 0,
        passRate: auditStats?.pass_rate ?? 0,
        avgAuditTimeSec: (auditStats?.avg_latency_ms ?? 0) / 1000,
        mlStatus: mlHealth.status,
        mlLatencyMs: mlHealth.latencyMs,
        queueDepth,
        avgOcrConfidence: ocrStats?.avg_ocr_confidence ?? 0,
        claimsByStatus: claimsByStatusResult.rows.map((row) => ({
          status: row.status,
          count: row.count,
        })),
        trend: trendResult.rows.map((row) => ({
          date: toDateString(row.day),
          passed: row.passed,
          failed: row.failed,
          warning: row.warning,
        })),
        claimsByType: claimsByTypeResult.rows.map((row) => ({
          type: row.type,
          count: row.count,
        })),
        documentProcessing: {
          totalDocs: documentStats?.total_docs ?? 0,
          completedDocs: documentStats?.completed_docs ?? 0,
          failedDocs: documentStats?.failed_docs ?? 0,
        },
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/dashboard/rules/top-failures', { preHandler: requirePermission('dashboard:view') }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const query = TopFailuresQuerySchema.parse(request.query);
    const tenantId = request.tenant.tenantId;
    const days = periodToDays(query.period);

    const [currentResult, previousResult] = await Promise.all([
      pool.query<TopFailureRow>(
        `SELECT
            rr.rule_id,
            COUNT(*)::int AS failures,
            COUNT(DISTINCT a.claim_id)::int AS affected_claims
           FROM rule_results rr
           JOIN audit_sessions a ON a.id = rr.audit_session_id
           JOIN claims c ON c.id = a.claim_id
          WHERE c.tenant_id = $1::uuid
            AND rr.result = 'FAIL'::rule_result_status
            AND a.started_at >= now() - ($2::int * INTERVAL '1 day')
          GROUP BY rr.rule_id
          ORDER BY failures DESC, rr.rule_id ASC
          LIMIT $3`,
        [tenantId, days, query.limit],
      ),
      pool.query<PreviousTopFailureRow>(
        `SELECT
            rr.rule_id,
            COUNT(*)::int AS failures
           FROM rule_results rr
           JOIN audit_sessions a ON a.id = rr.audit_session_id
           JOIN claims c ON c.id = a.claim_id
          WHERE c.tenant_id = $1::uuid
            AND rr.result = 'FAIL'::rule_result_status
            AND a.started_at >= now() - (($2::int * 2) * INTERVAL '1 day')
            AND a.started_at < now() - ($2::int * INTERVAL '1 day')
          GROUP BY rr.rule_id`,
        [tenantId, days],
      ),
    ]);

    const previousByRule = new Map(
      previousResult.rows.map((row) => [row.rule_id, row.failures]),
    );

    reply.send({
      data: {
        period: query.period,
        items: currentResult.rows.map((row) => {
          const previousFailures = previousByRule.get(row.rule_id) ?? 0;
          const trendPercent =
            previousFailures === 0
              ? row.failures > 0
                ? 100
                : 0
              : Number((((row.failures - previousFailures) / previousFailures) * 100).toFixed(2));

          return {
            ruleId: row.rule_id,
            failures: row.failures,
            affectedClaims: row.affected_claims,
            previousFailures,
            trendPercent,
          };
        }),
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/dashboard/officer-productivity', { preHandler: requirePermission('dashboard:view') }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const query = PeriodOnlyQuerySchema.parse(request.query);
    const tenantId = request.tenant.tenantId;
    const days = periodToDays(query.period);

    const result = await pool.query<ProductivityRow>(
      `WITH audits AS (
          SELECT
            a.user_id,
            COUNT(*)::int AS claims_audited,
            AVG(a.execution_time_ms)::float AS avg_audit_time_ms
          FROM audit_sessions a
          JOIN claims c ON c.id = a.claim_id
          WHERE c.tenant_id = $1::uuid
            AND a.started_at >= now() - ($2::int * INTERVAL '1 day')
          GROUP BY a.user_id
        ),
        corrections_summary AS (
          SELECT
            cr.corrected_by AS user_id,
            COUNT(*)::int AS corrections_count
          FROM corrections cr
          JOIN extracted_fields ef ON ef.id = cr.extracted_field_id
          JOIN claims c ON c.id = ef.claim_id
          WHERE c.tenant_id = $1::uuid
            AND cr.corrected_at >= now() - ($2::int * INTERVAL '1 day')
          GROUP BY cr.corrected_by
        )
        SELECT
          u.id AS user_id,
          u.display_name,
          u.role::text AS role,
          COALESCE(audits.claims_audited, 0)::int AS claims_audited,
          COALESCE(audits.avg_audit_time_ms, 0)::float AS avg_audit_time_ms,
          COALESCE(corrections_summary.corrections_count, 0)::int AS corrections_count
        FROM users u
        LEFT JOIN audits ON audits.user_id = u.id
        LEFT JOIN corrections_summary ON corrections_summary.user_id = u.id
        WHERE u.tenant_id = $1::uuid
          AND COALESCE(audits.claims_audited, 0) > 0
        ORDER BY claims_audited DESC, avg_audit_time_ms ASC, u.display_name ASC`,
      [tenantId, days],
    );

    reply.send({
      data: {
        period: query.period,
        items: result.rows.map((row) => ({
          userId: row.user_id,
          displayName: row.display_name,
          role: row.role,
          claimsAudited: row.claims_audited,
          avgAuditTimeSec: (row.avg_audit_time_ms ?? 0) / 1000,
          correctionsCount: row.corrections_count,
        })),
      },
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/dashboard/document-quality', { preHandler: requirePermission('dashboard:view') }, async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const query = PeriodOnlyQuerySchema.parse(request.query);
    const tenantId = request.tenant.tenantId;
    const days = periodToDays(query.period);

    const result = await pool.query<DocumentQualityRow>(
      `WITH page_stats AS (
          SELECT
            dp.document_id,
            AVG(dp.overall_confidence)::float AS avg_ocr_confidence
          FROM document_pages dp
          WHERE dp.overall_confidence IS NOT NULL
          GROUP BY dp.document_id
        ),
        field_stats AS (
          SELECT
            ef.document_id,
            COUNT(*)::int AS total_fields,
            COUNT(*) FILTER (WHERE ef.source = 'MANUAL')::int AS manual_fields
          FROM extracted_fields ef
          JOIN claims c ON c.id = ef.claim_id
          WHERE c.tenant_id = $1::uuid
          GROUP BY ef.document_id
        )
        SELECT
          d.doc_type::text AS doc_type,
          COUNT(d.id)::int AS documents_count,
          AVG(page_stats.avg_ocr_confidence)::float AS avg_ocr_confidence,
          CASE
            WHEN COALESCE(SUM(field_stats.total_fields), 0) = 0 THEN 0
            ELSE COALESCE(SUM(field_stats.manual_fields), 0)::float / NULLIF(SUM(field_stats.total_fields), 0)::float
          END AS manual_entry_rate
        FROM documents d
        JOIN claims c ON c.id = d.claim_id
        LEFT JOIN page_stats ON page_stats.document_id = d.id
        LEFT JOIN field_stats ON field_stats.document_id = d.id
        WHERE c.tenant_id = $1::uuid
          AND d.uploaded_at >= now() - ($2::int * INTERVAL '1 day')
        GROUP BY d.doc_type
        ORDER BY documents_count DESC, d.doc_type ASC`,
      [tenantId, days],
    );

    reply.send({
      data: {
        period: query.period,
        items: result.rows.map((row) => ({
          docType: row.doc_type,
          documentsCount: row.documents_count,
          avgOcrConfidence: row.avg_ocr_confidence ?? 0,
          manualEntryRate: row.manual_entry_rate ?? 0,
        })),
      },
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(dashboardRoutes, {
  name: 'dashboard-routes',
});




