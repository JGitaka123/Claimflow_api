import fp from 'fastify-plugin';
import { DomainError, ErrorCode } from '@claimflow/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { getTenantDb } from '../db/client.js';
import { getPrivilegedPool } from '../db/privileged.js';
import { createMeteringService, recordUsageDrop } from '../services/metering-service.js';

// Per-tenant + per-API-key rate limiting and usage metering (item 6d).
//
// Runs as a preHandler — AFTER the auth + tenant plugins have authenticated the
// request and bound the tenant into the async context — so the counter read/
// write happens on the claimflow_app role under RLS (getTenantDb), inside the
// request's already-bound tenant context. No privileged cross-tenant access.
//
// This is layered ON TOP of the coarse global per-IP limiter (rate-limit.ts),
// which stays as a pre-auth DoS guard. This plugin adds the per-tenant/per-key
// budget that doubles as the billing/metering source.

const WINDOW_MS = 60_000;

// Public/unauthenticated paths carry no tenant context — skip metering.
const SKIP_PATHS = new Set([
  '/health',
  '/health/ready',
  '/metrics',
  '/v1/auth/login',
  '/v1/auth/mfa/verify',
  '/v1/auth/refresh',
  '/v1/auth/logout',
  '/v1/oauth/token',
]);

function requestPath(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? request.url ?? '/';
  return rawUrl.split('?')[0] ?? rawUrl;
}

interface UsageMeteringOptions {
  config: Config;
}

const usageMeteringPlugin: FastifyPluginAsync<UsageMeteringOptions> = async (fastify, options) => {
  const db = getTenantDb(options.config);
  const metering = createMeteringService(db);
  // Privileged pool for the fail-open drop record only (the tenant-scoped path
  // has just failed when we use it — see recordUsageDrop).
  const privilegedPool = getPrivilegedPool(options.config);

  fastify.addHook('preHandler', async (request, reply) => {
    if (SKIP_PATHS.has(requestPath(request))) {
      return;
    }
    // Only meter authenticated, tenant-bound requests. If there is no tenant the
    // auth/tenant plugins will already have rejected; defensively skip.
    const tenantId = request.tenant?.tenantId ?? request.user?.tenantId;
    if (!tenantId) {
      return;
    }

    // Principal: the API key / OAuth client id for machine traffic; NULL for
    // human (JWT) traffic, which is metered at the tenant level.
    const principalId = request.apiKey?.id ?? null;
    const isMachine = principalId !== null;
    const fallback = isMachine ? options.config.API_KEY_RATE_LIMIT_RPM : options.config.TENANT_RATE_LIMIT_RPM;

    let decision;
    try {
      const limit = await metering.resolveLimit(tenantId, principalId, 'default', fallback);
      decision = await metering.recordAndCheck({
        tenantId,
        principalId,
        routeClass: 'default',
        limit,
        windowMs: WINDOW_MS,
      });
    } catch (error) {
      // LOUD fail-open. Metering/limiting is best-effort: a counter-store failure
      // must never take down the request path (the coarse global per-IP limiter
      // in rate-limit.ts remains the DoS floor). But the bypass must be VISIBLE,
      // not silent: bump a Prometheus counter, record the unmetered request to
      // usage_drops (privileged pool) for billing reconciliation, and warn-log a
      // structured, alertable event.
      fastify.metricsRegistry.recordMeteringFailOpen();
      request.log.warn(
        { err: error, event: 'metering_fail_open', tenantId, principalId, route: requestPath(request) },
        'usage metering failed; allowing request unmetered (fail-open)',
      );
      await recordUsageDrop(privilegedPool, { tenantId, principalId, routeClass: 'default', windowMs: WINDOW_MS });
      return;
    }

    reply.header('x-ratelimit-limit', String(decision.limit));
    reply.header('x-ratelimit-remaining', String(decision.remaining));
    reply.header('x-ratelimit-reset', String(decision.resetSeconds));

    if (!decision.allowed) {
      reply.header('retry-after', String(decision.resetSeconds));
      throw new DomainError(ErrorCode.RATE_LIMITED, 'Per-tenant request quota exceeded');
    }
  });
};

export default fp(usageMeteringPlugin, {
  name: 'usage-metering-plugin',
});
