import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

const REQUEST_DURATION_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

interface DurationSeries {
  bucketCounts: number[];
  sumMs: number;
  count: number;
}

export interface DatabaseMetrics {
  dbUp: number;
  claimStatusCounts: Map<string, number>;
  auditDecisionCounts: Map<string, number>;
  outboxUnpublished: number;
  queueStateCounts: Map<string, number>;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function normalizeMethod(method: string): string {
  const trimmed = method.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : 'UNKNOWN';
}

function normalizeRoute(route: string): string {
  const path = route.split('?')[0]?.trim();
  return path && path.length > 0 ? path : 'unknown';
}

function parseRequestCounterKey(key: string): { method: string; route: string; status: string } {
  const [method = 'UNKNOWN', route = 'unknown', status = '0'] = key.split('|');
  return { method, route, status };
}

function parseDurationKey(key: string): { method: string; route: string } {
  const [method = 'UNKNOWN', route = 'unknown'] = key.split('|');
  return { method, route };
}

export class MetricsRegistry {
  private readonly startedAtMs = Date.now();
  private readonly requestCounters = new Map<string, number>();
  private readonly durationByRoute = new Map<string, DurationSeries>();
  // Loud fail-open: total requests allowed through unmetered because the usage
  // counter store errored. A non-zero / rising value signals a counter-store
  // outage or a bypass probe — surfaced at /metrics for alerting.
  private meteringFailOpenTotal = 0;
  // Item 7: anomaly counters for alerting.
  // - Auth failures, labelled by kind: 'password' | 'mfa' | 'api_key' |
  //   'oauth_client' | 'locked'. Bumped at each existing failure point so
  //   alertmanager can fire on spikes (credential stuffing, key leakage probes).
  // - RLS denials: Postgres row-level-security violations bubbled through the
  //   error handler. Any non-zero rate is an alert-worthy invariant breach.
  private readonly authFailuresByKind = new Map<string, number>();
  private rlsDenialsTotal = 0;

  recordMeteringFailOpen(): void {
    this.meteringFailOpenTotal += 1;
  }

  recordAuthFailure(kind: 'password' | 'mfa' | 'api_key' | 'oauth_client' | 'locked'): void {
    this.authFailuresByKind.set(kind, (this.authFailuresByKind.get(kind) ?? 0) + 1);
  }

  recordRlsDenial(): void {
    this.rlsDenialsTotal += 1;
  }

  recordRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    const normalizedMethod = normalizeMethod(method);
    const normalizedRoute = normalizeRoute(route);
    const status = Number.isFinite(statusCode) ? Math.trunc(statusCode).toString() : '0';

    const requestKey = `${normalizedMethod}|${normalizedRoute}|${status}`;
    const requestCount = this.requestCounters.get(requestKey) ?? 0;
    this.requestCounters.set(requestKey, requestCount + 1);

    const durationKey = `${normalizedMethod}|${normalizedRoute}`;
    const existingSeries = this.durationByRoute.get(durationKey) ?? {
      bucketCounts: REQUEST_DURATION_BUCKETS_MS.map(() => 0),
      sumMs: 0,
      count: 0,
    };

    const safeDurationMs = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    existingSeries.sumMs += safeDurationMs;
    existingSeries.count += 1;

    for (const [index, bucket] of REQUEST_DURATION_BUCKETS_MS.entries()) {
      if (safeDurationMs <= bucket) {
        existingSeries.bucketCounts[index] = (existingSeries.bucketCounts[index] ?? 0) + 1;
      }
    }

    this.durationByRoute.set(durationKey, existingSeries);
  }

  render(databaseMetrics: DatabaseMetrics): string {
    const lines: string[] = [];

    const uptimeSeconds = Math.max(0, (Date.now() - this.startedAtMs) / 1000);

    lines.push('# HELP claimflow_process_uptime_seconds API process uptime in seconds.');
    lines.push('# TYPE claimflow_process_uptime_seconds gauge');
    lines.push(`claimflow_process_uptime_seconds ${uptimeSeconds.toFixed(3)}`);

    lines.push('# HELP claimflow_http_requests_total Total HTTP requests by method, route and status.');
    lines.push('# TYPE claimflow_http_requests_total counter');

    const requestEntries = [...this.requestCounters.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );

    for (const [key, count] of requestEntries) {
      const { method, route, status } = parseRequestCounterKey(key);
      lines.push(
        `claimflow_http_requests_total{method="${escapeLabelValue(method)}",route="${escapeLabelValue(route)}",status="${escapeLabelValue(status)}"} ${count}`,
      );
    }

    lines.push('# HELP claimflow_http_request_duration_ms HTTP request duration histogram in milliseconds.');
    lines.push('# TYPE claimflow_http_request_duration_ms histogram');

    const durationEntries = [...this.durationByRoute.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );

    for (const [key, series] of durationEntries) {
      const { method, route } = parseDurationKey(key);
      let cumulative = 0;

      for (const [index, bucket] of REQUEST_DURATION_BUCKETS_MS.entries()) {
        cumulative += series.bucketCounts[index] ?? 0;
        lines.push(
          `claimflow_http_request_duration_ms_bucket{method="${escapeLabelValue(method)}",route="${escapeLabelValue(route)}",le="${bucket}"} ${cumulative}`,
        );
      }

      lines.push(
        `claimflow_http_request_duration_ms_bucket{method="${escapeLabelValue(method)}",route="${escapeLabelValue(route)}",le="+Inf"} ${series.count}`,
      );
      lines.push(
        `claimflow_http_request_duration_ms_sum{method="${escapeLabelValue(method)}",route="${escapeLabelValue(route)}"} ${series.sumMs.toFixed(3)}`,
      );
      lines.push(
        `claimflow_http_request_duration_ms_count{method="${escapeLabelValue(method)}",route="${escapeLabelValue(route)}"} ${series.count}`,
      );
    }

    lines.push('# HELP claimflow_db_up Database connectivity status (1=up, 0=down).');
    lines.push('# TYPE claimflow_db_up gauge');
    lines.push(`claimflow_db_up ${databaseMetrics.dbUp}`);

    lines.push('# HELP claimflow_metering_fail_open_total Requests allowed through unmetered due to a counter-store error.');
    lines.push('# TYPE claimflow_metering_fail_open_total counter');
    lines.push(`claimflow_metering_fail_open_total ${this.meteringFailOpenTotal}`);

    lines.push('# HELP claimflow_auth_failures_total Authentication failures by credential kind.');
    lines.push('# TYPE claimflow_auth_failures_total counter');
    for (const [kind, count] of [...this.authFailuresByKind.entries()].sort(([l], [r]) => l.localeCompare(r))) {
      lines.push(`claimflow_auth_failures_total{kind="${escapeLabelValue(kind)}"} ${count}`);
    }

    lines.push('# HELP claimflow_rls_denials_total Row-level-security policy violations.');
    lines.push('# TYPE claimflow_rls_denials_total counter');
    lines.push(`claimflow_rls_denials_total ${this.rlsDenialsTotal}`);

    lines.push('# HELP claimflow_claims_total Claims grouped by status.');
    lines.push('# TYPE claimflow_claims_total gauge');
    for (const [status, count] of [...databaseMetrics.claimStatusCounts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`claimflow_claims_total{status="${escapeLabelValue(status)}"} ${count}`);
    }

    lines.push('# HELP claimflow_audit_sessions_total Audit sessions grouped by decision.');
    lines.push('# TYPE claimflow_audit_sessions_total gauge');
    for (const [decision, count] of [...databaseMetrics.auditDecisionCounts.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      lines.push(`claimflow_audit_sessions_total{decision="${escapeLabelValue(decision)}"} ${count}`);
    }

    lines.push('# HELP claimflow_outbox_unpublished_total Outbox events pending publish.');
    lines.push('# TYPE claimflow_outbox_unpublished_total gauge');
    lines.push(`claimflow_outbox_unpublished_total ${databaseMetrics.outboxUnpublished}`);

    lines.push('# HELP claimflow_queue_jobs_total Queue jobs grouped by state.');
    lines.push('# TYPE claimflow_queue_jobs_total gauge');
    for (const [state, count] of [...databaseMetrics.queueStateCounts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`claimflow_queue_jobs_total{state="${escapeLabelValue(state)}"} ${count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

const metricsPlugin: FastifyPluginAsync = async (fastify) => {
  const metricsRegistry = new MetricsRegistry();
  const requestStartTimes = new WeakMap<FastifyRequest, bigint>();

  fastify.decorate('metricsRegistry', metricsRegistry);

  fastify.addHook('onRequest', async (request) => {
    requestStartTimes.set(request, process.hrtime.bigint());
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStartTimes.get(request);

    if (startedAt === undefined) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const routePath = typeof request.routeOptions.url === 'string' ? request.routeOptions.url : request.url;

    metricsRegistry.recordRequest(request.method, routePath, reply.statusCode, durationMs);
  });
};

export default fp(metricsPlugin, {
  name: 'metrics-plugin',
});