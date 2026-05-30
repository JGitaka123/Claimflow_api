import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DomainError, ErrorCode, type ApiErrorResponse } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import { loadConfig, type Config } from '../config.js';

function createTestConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    exitOnError: false,
    env: {
      DATABASE_URL: 'postgres://claimflow:dev@localhost:5432/claimflow',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_RPM: '100',
    },
  });

  return {
    ...base,
    ...overrides,
  };
}

function createAuthHeader(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'user-1',
      tenantId: 'tenant-1',
      facilityId: 'facility-1',
      role: 'claims_officer',
    }),
  ).toString('base64url');

  return `Bearer ${header}.${payload}.signature`;
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();

    if (app) {
      await app.close();
    }
  }
});

describe('API server foundation', () => {
  it('GET /health returns 200', async () => {
    const app = buildServer({ config: createTestConfig() });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json() as { status: string; timestamp: string };
    expect(payload.status).toBe('ok');
    expect(typeof payload.timestamp).toBe('string');
  });
  it('GET /metrics exposes Prometheus text and stays public', async () => {
    const app = buildServer({ config: createTestConfig() });
    apps.push(app);

    await app.inject({
      method: 'GET',
      url: '/health',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');

    expect(response.body).toContain('claimflow_process_uptime_seconds');
    expect(response.body).toContain('claimflow_http_requests_total');
    expect(response.body).toContain('claimflow_db_up');
    expect(response.body).toContain('route="/health"');
  });

  it('rate limiting returns 429 after configured limit is exceeded', async () => {
    const app = buildServer({
      config: createTestConfig({
        RATE_LIMIT_RPM: 1,
      }),
    });
    apps.push(app);

    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    const payload = second.json() as ApiErrorResponse;
    expect(payload.errors[0].code).toBe(ErrorCode.RATE_LIMITED);
  });

  it('error handler returns envelope for domain errors', async () => {
    const app = buildServer({ config: createTestConfig() });
    apps.push(app);

    app.get('/health/domain-error', async () => {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found', {
        field: 'claimId',
      });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health/domain-error',
      headers: {
        authorization: createAuthHeader(),
      },
    });

    expect(response.statusCode).toBe(404);

    const payload = response.json() as ApiErrorResponse;
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0]).toMatchObject({
      code: ErrorCode.NOT_FOUND,
      message: 'Claim not found',
      field: 'claimId',
    });
    expect(payload.meta.requestId).toBeTruthy();
  });

  it('error handler maps zod validation errors to VALIDATION_ERROR', async () => {
    const app = buildServer({ config: createTestConfig() });
    apps.push(app);

    app.get('/health/zod-error', async () => {
      z.object({ requiredValue: z.string().min(1) }).parse({});
      return { ok: true };
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health/zod-error',
      headers: {
        authorization: createAuthHeader(),
      },
    });

    expect(response.statusCode).toBe(400);

    const payload = response.json() as ApiErrorResponse;
    expect(payload.errors[0].code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(payload.meta.requestId).toBeTruthy();
  });

  it('unknown errors are sanitized and do not leak internals', async () => {
    const app = buildServer({ config: createTestConfig() });
    apps.push(app);

    app.get('/health/explode', async () => {
      throw new Error('sensitive stack data');
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health/explode',
      headers: {
        authorization: createAuthHeader(),
      },
    });

    expect(response.statusCode).toBe(500);

    const payload = response.json() as ApiErrorResponse;
    expect(payload.errors[0]).toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });

    expect(response.body).not.toContain('sensitive stack data');
    expect(payload.meta.requestId).toBeTruthy();
  });
});
