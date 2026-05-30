import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { QueryContext } from '../types/request-context.js';

let sharedPool: Pool | null = null;

export function getPool(config: Pick<Config, 'DATABASE_URL' | 'DB_POOL_MIN' | 'DB_POOL_MAX'>): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: config.DATABASE_URL,
      min: config.DB_POOL_MIN,
      max: config.DB_POOL_MAX,
    });
  }

  return sharedPool;
}

export async function query<T extends QueryResultRow>(
  pool: Pool,
  logger: FastifyBaseLogger,
  sql: string,
  params: readonly unknown[] = [],
  context: QueryContext = {},
): Promise<QueryResult<T>> {
  const startedAt = Date.now();

  try {
    const result = await pool.query<T>(sql, [...params]);

    logger.debug(
      {
        requestId: context.requestId,
        tenantId: context.tenantId,
        userId: context.userId,
        route: context.route,
        durationMs: Date.now() - startedAt,
        rowCount: result.rowCount,
      },
      'database query complete',
    );

    return result;
  } catch (error) {
    logger.error(
      {
        err: error,
        requestId: context.requestId,
        tenantId: context.tenantId,
        userId: context.userId,
        route: context.route,
        durationMs: Date.now() - startedAt,
      },
      'database query failed',
    );

    throw error;
  }
}

export async function closePool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}
