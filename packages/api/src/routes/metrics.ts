import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify';
import type { Pool, QueryResultRow } from 'pg';
import { getPool } from '../db/client.js';
import type { DatabaseMetrics } from '../plugins/metrics.js';

interface GroupCountRow extends QueryResultRow {
  label: string;
  count: string;
}

interface CountRow extends QueryResultRow {
  count: string;
}

interface ExistsRow extends QueryResultRow {
  table_exists: boolean;
}

function parseCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function safeQueryRows<T extends QueryResultRow>(
  pool: Pool,
  logger: FastifyBaseLogger,
  sql: string,
): Promise<T[]> {
  try {
    const result = await pool.query<T>(sql);
    return result.rows;
  } catch (error) {
    logger.debug({ err: error, sql }, 'metrics query failed');
    return [];
  }
}

async function collectDatabaseMetrics(pool: Pool, logger: FastifyBaseLogger): Promise<DatabaseMetrics> {
  const metrics: DatabaseMetrics = {
    dbUp: 0,
    claimStatusCounts: new Map<string, number>(),
    auditDecisionCounts: new Map<string, number>(),
    outboxUnpublished: 0,
    queueStateCounts: new Map<string, number>(),
  };

  try {
    await pool.query('SELECT 1');
    metrics.dbUp = 1;
  } catch (error) {
    logger.warn({ err: error }, 'metrics database connectivity check failed');
    return metrics;
  }

  const claimStatusesRows = await safeQueryRows<GroupCountRow>(
    pool,
    logger,
    `
      SELECT status::text AS label, count(*)::bigint::text AS count
      FROM claims
      GROUP BY status
    `,
  );

  for (const row of claimStatusesRows) {
    metrics.claimStatusCounts.set(row.label, parseCount(row.count));
  }

  const auditDecisionRows = await safeQueryRows<GroupCountRow>(
    pool,
    logger,
    `
      SELECT decision::text AS label, count(*)::bigint::text AS count
      FROM audit_sessions
      WHERE decision IS NOT NULL
      GROUP BY decision
    `,
  );

  for (const row of auditDecisionRows) {
    metrics.auditDecisionCounts.set(row.label, parseCount(row.count));
  }

  const outboxRows = await safeQueryRows<CountRow>(
    pool,
    logger,
    `
      SELECT count(*)::bigint::text AS count
      FROM outbox_events
      WHERE published = false
    `,
  );

  const outboxCount = outboxRows[0]?.count;
  if (outboxCount !== undefined) {
    metrics.outboxUnpublished = parseCount(outboxCount);
  }

  const queueTableRows = await safeQueryRows<ExistsRow>(
    pool,
    logger,
    `
      SELECT to_regclass('pgboss.job') IS NOT NULL AS table_exists
    `,
  );

  const queueTableExists = queueTableRows[0]?.table_exists ?? false;

  if (queueTableExists) {
    const queueStateRows = await safeQueryRows<GroupCountRow>(
      pool,
      logger,
      `
        SELECT state::text AS label, count(*)::bigint::text AS count
        FROM pgboss.job
        GROUP BY state
      `,
    );

    for (const row of queueStateRows) {
      metrics.queueStateCounts.set(row.label, parseCount(row.count));
    }
  }

  return metrics;
}

const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/metrics', async (_request, reply) => {
    const pool = getPool(fastify.config);
    const databaseMetrics = await collectDatabaseMetrics(pool, fastify.log);
    const payload = fastify.metricsRegistry.render(databaseMetrics);

    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return payload;
  });
};

export default fp(metricsRoutes, {
  name: 'metrics-routes',
});