import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request log context — separate from the tenant async-local in `db/client.ts`
 * so this slice does not modify the security-critical tenant-binding path. The
 * tenant plugin enters BOTH stores (tenant + log context) at the same point;
 * pino's mixin reads from here so every log line emitted during the request
 * automatically carries the request-scoped fields.
 */
export interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  principalId?: string;
  principalKind?: 'jwt' | 'api_key' | 'oauth_client';
}

const logStorage = new AsyncLocalStorage<LogContext>();

/** The context bound to the current async chain, or an empty object. */
export function currentLogContext(): LogContext {
  return logStorage.getStore() ?? {};
}

/**
 * Bind log context for the remainder of this async chain. Called from the
 * tenant/auth preHandler, where there is no callback to wrap — handlers run in
 * a continuation of the same context (mirrors `enterTenantContext`).
 */
export function enterLogContext(ctx: LogContext): void {
  logStorage.enterWith({ ...currentLogContext(), ...ctx });
}

/** Wrap a callback in a fresh log context (used by background workers). */
export function runWithLogContext<T>(ctx: LogContext, callback: () => Promise<T>): Promise<T> {
  return logStorage.run({ ...ctx }, callback);
}

/**
 * pino mixin — invoked on every log call. Pulls the current request context out
 * of the async-local store and merges it into the log record so a single line
 * carries `tenantId`/`userId`/`principalId`/`requestId` without any caller
 * having to thread them through manually.
 */
export function logContextMixin(): Record<string, unknown> {
  const ctx = currentLogContext();
  const out: Record<string, unknown> = {};
  if (ctx.requestId) out['requestId'] = ctx.requestId;
  if (ctx.tenantId) out['tenantId'] = ctx.tenantId;
  if (ctx.userId) out['userId'] = ctx.userId;
  if (ctx.principalId) out['principalId'] = ctx.principalId;
  if (ctx.principalKind) out['principalKind'] = ctx.principalKind;
  return out;
}
