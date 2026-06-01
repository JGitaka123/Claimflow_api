import type { TenantDb } from '../db/client.js';

// ============================================================================
// Metering + per-tenant/per-key rate limiting (item 6d)
// ----------------------------------------------------------------------------
// Counters and quotas are tenant-scoped Postgres tables under the SAME RLS model
// as every other tenant table. This service is always called inside a bound
// tenant context (runWithTenant / the request's ALS context), so every read and
// write goes through the claimflow_app role with app.current_tenant set — there
// is NO privileged cross-tenant access on the request path.
//
// Correctness under concurrency: the counter is bumped with a single
// INSERT ... ON CONFLICT ... DO UPDATE SET request_count = request_count + 1
// statement, which is atomic per row. The post-increment value is returned via
// RETURNING, so parallel requests in the same window each observe a distinct
// monotonic count — no double-count, no lost-count, no read-modify-write race.
// ============================================================================

export interface RateDecision {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  /** Seconds until the current fixed window resets. */
  resetSeconds: number;
}

export interface MeterParams {
  tenantId: string;
  /** API key / OAuth client id, or null for human (JWT) traffic. */
  principalId: string | null;
  routeClass: string;
  /** Effective limit (already resolved from policy/config by the caller). */
  limit: number;
  /** Window length in ms (fixed window). */
  windowMs: number;
  now?: Date;
}

const WINDOW_PLACEHOLDER_PRINCIPAL = '-';

interface CounterRow {
  request_count: string;
}

interface PolicyRow {
  max_per_minute: number;
}

export interface MeteringService {
  /**
   * Atomically record one request and decide whether it is within budget.
   * Increments first, then compares — fixed-window semantics. The window start
   * is the timestamp truncated to the window size.
   */
  recordAndCheck: (params: MeterParams) => Promise<RateDecision>;
  /**
   * Resolve the effective per-minute limit for a principal: a per-principal
   * policy row wins, else a tenant-wide (NULL principal) policy row, else the
   * provided default. Read on the app role under RLS.
   */
  resolveLimit: (tenantId: string, principalId: string | null, routeClass: string, fallback: number) => Promise<number>;
}

function windowStart(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

export function createMeteringService(db: TenantDb): MeteringService {
  return {
    async resolveLimit(tenantId, principalId, routeClass, fallback): Promise<number> {
      // Prefer a per-principal policy, then the tenant-wide default. RLS already
      // confines rows to the current tenant; the tenant_id filter is belt-and-braces.
      const result = await db.query<PolicyRow>(
        `SELECT max_per_minute
           FROM rate_limit_policies
          WHERE tenant_id = $1::uuid
            AND route_class = $2
            AND (principal_id = $3 OR principal_id IS NULL)
          ORDER BY (principal_id = $3) DESC
          LIMIT 1`,
        [tenantId, routeClass, principalId ?? WINDOW_PLACEHOLDER_PRINCIPAL],
      );
      const row = result.rows[0];
      return row ? row.max_per_minute : fallback;
    },

    async recordAndCheck(params): Promise<RateDecision> {
      const now = params.now ?? new Date();
      const start = windowStart(now, params.windowMs);
      const principal = params.principalId ?? WINDOW_PLACEHOLDER_PRINCIPAL;

      // Atomic increment + read-back. The unique key (tenant, principal,
      // route_class, window_start) makes the upsert race-free.
      const result = await db.query<CounterRow>(
        `INSERT INTO usage_counters (tenant_id, principal_id, route_class, window_start, request_count, updated_at)
         VALUES ($1::uuid, $2, $3, $4::timestamptz, 1, now())
         ON CONFLICT (tenant_id, principal_id, route_class, window_start)
         DO UPDATE SET request_count = usage_counters.request_count + 1, updated_at = now()
         RETURNING request_count`,
        [params.tenantId, principal, params.routeClass, start.toISOString()],
      );

      const used = Number.parseInt(result.rows[0]?.request_count ?? '1', 10);
      const remaining = Math.max(0, params.limit - used);
      const resetSeconds = Math.ceil((start.getTime() + params.windowMs - now.getTime()) / 1000);

      return {
        allowed: used <= params.limit,
        limit: params.limit,
        used,
        remaining,
        resetSeconds: Math.max(0, resetSeconds),
      };
    },
  };
}
