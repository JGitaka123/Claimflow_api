import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { DomainError, ErrorCode } from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { QueryContext } from '../types/request-context.js';

// ============================================================================
// Two-pool model for Row-Level Security (item 6c)
// ----------------------------------------------------------------------------
// - The APP pool connects as the non-superuser, non-BYPASSRLS `claimflow_app`
//   role (APP_DATABASE_URL). Every tenant-scoped statement runs through a
//   `TenantDb` that sets `app.current_tenant` with SET LOCAL inside a
//   transaction, so RLS policies isolate the tenant and the value can never
//   bleed across pooled connections.
// - The PRIVILEGED pool connects as the owner / BYPASSRLS role (DATABASE_URL).
//   It is reserved for genuinely cross-tenant or pre-tenant work (credential
//   verification, the cross-tenant /metrics aggregate, background workers that
//   set the tenant per job). Access is deliberately narrow — see the allowlist
//   in db/privileged.ts.
//
// The raw app pool is NOT exported. Tenant code can only reach the database via
// getTenantDb()/runWithTenant(); unbound access fails closed (throws).
// ============================================================================

type DbConfig = Pick<Config, 'DATABASE_URL' | 'APP_DATABASE_URL' | 'DB_POOL_MIN' | 'DB_POOL_MAX'>;

let appPool: Pool | null = null;
let privilegedPool: Pool | null = null;

const tenantStorage = new AsyncLocalStorage<{ tenantId: string }>();

/** UUID shape guard so an empty/garbage tenant can never reach `::uuid` and error-bypass. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildPool(connectionString: string, config: DbConfig): Pool {
  return new Pool({
    connectionString,
    min: config.DB_POOL_MIN,
    max: config.DB_POOL_MAX,
  });
}

/**
 * The privileged (owner / BYPASSRLS) pool. Internal to the db layer — callers
 * reach it only through the allowlisted helpers in db/privileged.ts. Falls back
 * to nothing: DATABASE_URL is always present (validated in config).
 */
export function getPrivilegedPoolInternal(config: DbConfig): Pool {
  if (!privilegedPool) {
    privilegedPool = buildPool(config.DATABASE_URL, config);
  }
  return privilegedPool;
}

/**
 * The application pool (claimflow_app role). Private to this module: never
 * returned to callers, only used by TenantDb. When APP_DATABASE_URL is unset we
 * fall back to DATABASE_URL so dev/test work before the role is provisioned —
 * config.ts emits a warning in production when this happens.
 */
function getAppPool(config: DbConfig): Pool {
  if (!appPool) {
    appPool = buildPool(config.APP_DATABASE_URL ?? config.DATABASE_URL, config);
  }
  return appPool;
}

export class TenantContextMissingError extends Error {
  constructor() {
    super('No tenant context bound: tenant-scoped database access requires runWithTenant()');
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Run `callback` with a bound tenant context. The tenant id is validated as a
 * UUID up front so an empty string or garbage value can never reach the policy
 * cast — it is rejected here, fail-closed, before any query runs.
 */
export function runWithTenant<T>(tenantId: string, callback: () => Promise<T>): Promise<T> {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new TenantContextMissingError();
  }
  return tenantStorage.run({ tenantId }, callback);
}

/**
 * Bind a tenant to the current async execution for the remainder of its life
 * (used from the Fastify auth/tenant hook, where there is no callback to wrap —
 * the route handler runs in a continuation of this same context). A present but
 * malformed tenant (non-UUID) means a tampered/invalid token, so it fails as a
 * clean 401 rather than a generic 500. Does no DB I/O — request validation in
 * the handler still runs (and can return 400) before any tenant-scoped query.
 */
export function enterTenantContext(tenantId: string): void {
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
    throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid tenant context in token');
  }
  tenantStorage.enterWith({ tenantId });
}

/** The tenant bound to the current async context, or null if none. */
export function currentTenantId(): string | null {
  return tenantStorage.getStore()?.tenantId ?? null;
}

/**
 * Tenant-scoped database handle. Every operation opens a transaction, sets
 * `app.current_tenant` LOCAL to that transaction, runs the work on the same
 * client, then commits. The GUC is therefore scoped to a single transaction and
 * cannot survive connection reuse. Fails closed when no tenant is bound.
 */
export interface TenantDb {
  /** Single tenant-scoped statement (wrapped in its own one-shot transaction). */
  query<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** Multi-statement tenant-scoped transaction; all statements share the bound tenant. */
  transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
}

/**
 * Minimal read/write surface shared by a transaction client and a TenantDb, for
 * helpers that accept either. Both `PoolClient` and `TenantDb` satisfy it.
 */
export interface Queryable {
  query<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

async function bindTenant(client: PoolClient, tenantId: string): Promise<void> {
  // SET LOCAL (set_config(..., true)) — scoped to this transaction only.
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
}

class PoolTenantDb implements TenantDb {
  constructor(private readonly pool: Pool) {}

  private requireTenant(): string {
    const tenantId = currentTenantId();
    if (!tenantId) {
      throw new TenantContextMissingError();
    }
    return tenantId;
  }

  async query<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return this.transaction((client) => client.query<T>(sql, [...params]));
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const tenantId = this.requireTenant();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await bindTenant(client, tenantId);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * The tenant-scoped database handle, backed by the app-role pool. This is the
 * ONLY way tenant code reaches the database. The handle reads its tenant from
 * the async-local context at call time, so a single instance is safe to share.
 */
export function getTenantDb(config: DbConfig): TenantDb {
  return new PoolTenantDb(getAppPool(config));
}

/**
 * Legacy query helper retained for the privileged path (metrics, workers). It
 * logs timings and never participates in RLS. Tenant code must not use this.
 */
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

/**
 * Owner/superuser pool for TEST HARNESSES and MIGRATION/SEED scripts ONLY.
 * Connects as the migration owner (DATABASE_URL) which bypasses RLS, so it must
 * never be used by application code — doing so would reopen the cross-tenant
 * bypass that RLS closes. The RLS import guard forbids non-test, non-script code
 * from importing this. Application code uses getTenantDb() (tenant paths) or
 * getPrivilegedPool() from db/privileged.ts (allowlisted cross-tenant paths).
 * @internal test/migration use only
 */
export function getAdminPool(config: DbConfig): Pool {
  return getPrivilegedPoolInternal(config);
}

export async function closePool(): Promise<void> {
  const pools = [appPool, privilegedPool].filter((p): p is Pool => p !== null);
  appPool = null;
  privilegedPool = null;
  await Promise.all(pools.map((p) => p.end()));
}
