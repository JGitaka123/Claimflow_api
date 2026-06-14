import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { DomainError, ErrorCode } from '@claimflow/shared';
import { getTenantDb } from '../db/client.js';
import { getPrivilegedPool } from '../db/privileged.js';

/**
 * GET /v1/usage — the calling tenant's own metering view (item 7).
 *
 * - usage_counters lookup goes through the app role (`getTenantDb`) so RLS
 *   policies enforce tenant isolation as the authoritative backstop.
 * - usage_drops is owner-only / NOT under RLS (migration 026), so the few rows
 *   we surface MUST be explicitly filtered by `tenant_id = $current` against
 *   the privileged pool — never returned unfiltered. The brief is explicit on
 *   this rule.
 */
const usageRoutes: FastifyPluginAsync = async (fastify) => {
  const tenantDb = getTenantDb(fastify.config);

  fastify.get('/v1/usage', async (request) => {
    if (!request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }
    const tenantId = request.user.tenantId;

    // Last 24h of windows; tenant-scoped via the app role under RLS.
    const counters = await tenantDb.query<{
      principal_id: string;
      route_class: string;
      window_start: string;
      request_count: string;
    }>(
      `SELECT principal_id, route_class, window_start, request_count::text AS request_count
         FROM usage_counters
        WHERE window_start >= now() - INTERVAL '24 hours'
        ORDER BY window_start DESC, principal_id, route_class
        LIMIT 1000`,
    );

    // usage_drops is owner-only; explicit tenant_id filter is the contract.
    const dropsResult = await getPrivilegedPool(fastify.config).query<{
      principal_id: string;
      route_class: string;
      window_start: string;
      dropped_count: string;
      reason: string;
    }>(
      `SELECT principal_id, route_class, window_start, dropped_count::text AS dropped_count, reason
         FROM usage_drops
        WHERE tenant_id = $1::uuid
          AND window_start >= now() - INTERVAL '24 hours'
        ORDER BY window_start DESC, principal_id, route_class
        LIMIT 1000`,
      [tenantId],
    );

    return {
      data: {
        windowHours: 24,
        counters: counters.rows.map((row) => ({
          principalId: row.principal_id,
          routeClass: row.route_class,
          windowStart: new Date(row.window_start).toISOString(),
          requestCount: Number(row.request_count),
        })),
        drops: dropsResult.rows.map((row) => ({
          principalId: row.principal_id,
          routeClass: row.route_class,
          windowStart: new Date(row.window_start).toISOString(),
          droppedCount: Number(row.dropped_count),
          reason: row.reason,
        })),
      },
      meta: { requestId: request.id },
    };
  });
};

export default fp(usageRoutes, { name: 'usage-routes' });
