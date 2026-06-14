import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { loadConfig, type Config } from '../config.js';

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: 'postgres://claimflow:dev@localhost:5432/claimflow',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '100000',
      },
    }),
    ...overrides,
  };
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await app.close();
  }
});

describe('observability (item 7)', () => {
  it('exposes the new auth_failures and rls_denials counters at /metrics', async () => {
    const app = buildServer({ config: testConfig() });
    apps.push(app);

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('# TYPE claimflow_auth_failures_total counter');
    expect(res.body).toContain('# TYPE claimflow_rls_denials_total counter');
    expect(res.body).toContain('claimflow_rls_denials_total 0');
  });

  it('bumps claimflow_auth_failures_total{kind="api_key"} on an invalid API key', async () => {
    const app = buildServer({ config: testConfig() });
    apps.push(app);

    const before = await app.inject({ method: 'GET', url: '/metrics' });
    expect(before.body).not.toMatch(/claimflow_auth_failures_total\{kind="api_key"\} [1-9]/);

    // Hit a tenant-scoped endpoint with a bad API key — verifyApiKey errors AND
    // bumps the counter; the request fails with UNAUTHORIZED.
    const bad = await app.inject({
      method: 'GET',
      url: '/v1/claims',
      headers: { 'x-api-key': 'cf_deadbeef_garbage_not_a_real_key_at_all' },
    });
    expect([401]).toContain(bad.statusCode);

    const after = await app.inject({ method: 'GET', url: '/metrics' });
    expect(after.body).toMatch(/claimflow_auth_failures_total\{kind="api_key"\} 1/);
  });

  it('/health/ready returns 503 when the DB pool refuses to connect', async () => {
    // Point at a definitely-unreachable Postgres so the probe MUST fail.
    const app = buildServer({
      config: testConfig({
        DATABASE_URL: 'postgres://claimflow:dev@127.0.0.1:1/claimflow',
      }),
    });
    apps.push(app);

    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { status: string; checks: { db: string } };
    expect(body.status).toBe('not_ready');
    expect(body.checks.db).toBe('fail');
  });

  it('/health stays a cheap liveness probe (does not touch the DB)', async () => {
    // Even with a broken DB URL, /health must still answer 200 — it's liveness only.
    const app = buildServer({
      config: testConfig({
        DATABASE_URL: 'postgres://claimflow:dev@127.0.0.1:1/claimflow',
      }),
    });
    apps.push(app);

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
