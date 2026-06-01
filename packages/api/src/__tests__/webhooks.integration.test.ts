import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebhookEventType } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getAdminPool, getTenantDb, runWithTenant, closePool } from '../db/client.js';
import { buildServer } from '../server.js';
import { createWebhookService, type WebhookSender } from '../services/webhook-service.js';
import { verifyWebhookSignature } from '../integrations/webhook-signing.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rulepacksDir = resolve(currentDir, '../../../../rulepacks');
const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

function adminAuthHeader(context: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: context.userId, tenantId: context.tenantId, facilityId: context.facilityId, role: 'admin' }),
  ).toString('base64url');
  return `Bearer ${header}.${payload}.signature`;
}

async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = resolve(currentDir, '../../../../migrations');
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [951337]);
    for (const file of files) {
      const sql = await readFile(resolve(migrationsDir, file), 'utf8');
      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${file}`, { cause: error as Error });
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [951337]);
    } catch {
      // ignore
    }
    client.release();
  }
}

async function truncate(pool: Pool): Promise<void> {
  const rows = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename NOT IN ('schema_migrations','payers','icd_codes','sha_service_codes')`,
  );
  if (rows.rows.length === 0) {
    return;
  }
  await pool.query(`TRUNCATE TABLE ${rows.rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  authHeader: string;
}

async function seed(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();
  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1::uuid,$2,$3)`, [
    tenantId,
    'WH Tenant',
    `tenant-${tenantId.slice(0, 8)}`,
  ]);
  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, sha_provider_id, tier_level, county, is_active)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,true)`,
    [facilityId, tenantId, 'WH Facility', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'admin'::user_role,true,false)`,
    [userId, tenantId, facilityId, 'wh.admin@example.org', 'WH Admin', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );
  return { tenantId, facilityId, userId, authHeader: adminAuthHeader({ tenantId, facilityId, userId }) };
}

integrationDescribe('Webhooks integration (real Postgres)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }
    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: integrationDatabaseUrl,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '1000',
        RULEPACK_DIR: rulepacksDir,
      },
    });
    pool = getAdminPool(config);
    await runMigrations(pool);
    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) {
      throw new Error('pool not initialized');
    }
    await truncate(pool);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await closePool();
  });

  it('registers an endpoint (secret returned once) and hides the secret on list', async () => {
    const s = await seed(pool!);

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { authorization: s.authHeader },
      payload: { url: 'https://example.test/hook', events: [WebhookEventType.CLAIM_FLAGGED], description: 'test' },
    });

    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { data: { id: string; secret?: string; events: string[] } };
    expect(createdBody.data.secret?.startsWith('whsec_')).toBe(true);
    expect(createdBody.data.events).toEqual([WebhookEventType.CLAIM_FLAGGED]);

    const list = await app!.inject({ method: 'GET', url: '/v1/webhooks', headers: { authorization: s.authHeader } });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { data: Array<{ id: string; secret?: string }> };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.secret).toBeUndefined();
  });

  it('delivers a queued event with a verifiable signature', async () => {
    const s = await seed(pool!);
    const service = createWebhookService(getTenantDb(config), app!.log);

    const { endpoint, secret, enqueued } = await runWithTenant(s.tenantId, async () => {
      const ep = await service.createEndpoint(s.tenantId, {
        url: 'https://example.test/hook',
        events: [WebhookEventType.CLAIM_FLAGGED],
      });
      const count = await getTenantDb(config).transaction((client) =>
        service.enqueueEvent(client, s.tenantId, WebhookEventType.CLAIM_FLAGGED, {
          claimId: 'claim-123',
          decision: 'FAILED',
        }),
      );
      return { endpoint: ep, secret: ep.secret as string, enqueued: count };
    });
    expect(enqueued).toBe(1);

    const captured: Array<{ headers: Record<string, string>; body: string }> = [];
    const sender: WebhookSender = async ({ headers, body }) => {
      captured.push({ headers, body });
      return { status: 200 };
    };

    // Dispatch is cross-tenant background work: it runs on the privileged pool.
    const result = await service.dispatchDueDeliveries(pool!, { sender });
    expect(result.delivered).toBe(1);
    expect(captured).toHaveLength(1);

    const signature = captured[0]?.headers['x-claimflow-signature'] ?? '';
    const body = captured[0]?.body ?? '';
    expect(verifyWebhookSignature(secret, signature, body)).toBe(true);

    const deliveries = await runWithTenant(s.tenantId, () => service.listDeliveries(s.tenantId, endpoint.id));
    expect(deliveries[0]?.status).toBe('DELIVERED');
    expect(deliveries[0]?.responseStatus).toBe(200);
  });

  it('schedules a backoff retry when delivery fails', async () => {
    const s = await seed(pool!);
    const service = createWebhookService(getTenantDb(config), app!.log);
    const endpoint = await runWithTenant(s.tenantId, async () => {
      const ep = await service.createEndpoint(s.tenantId, {
        url: 'https://example.test/hook',
        events: [WebhookEventType.CLAIM_FLAGGED],
      });
      await getTenantDb(config).transaction((client) =>
        service.enqueueEvent(client, s.tenantId, WebhookEventType.CLAIM_FLAGGED, { claimId: 'c1' }),
      );
      return ep;
    });

    const failing: WebhookSender = async () => ({ status: 500 });
    const result = await service.dispatchDueDeliveries(pool!, { sender: failing });
    expect(result.failed).toBe(1);

    const deliveries = await runWithTenant(s.tenantId, () => service.listDeliveries(s.tenantId, endpoint.id));
    expect(deliveries[0]?.status).toBe('FAILED');
    expect(deliveries[0]?.attempts).toBe(1);
    expect(deliveries[0]?.nextAttemptAt).not.toBeNull();
  });

  it('emits claim.flagged when a scored claim is not PASSED', async () => {
    const s = await seed(pool!);
    const service = createWebhookService(getTenantDb(config), app!.log);
    await runWithTenant(s.tenantId, () =>
      service.createEndpoint(s.tenantId, {
        url: 'https://example.test/hook',
        events: [WebhookEventType.CLAIM_FLAGGED],
      }),
    );

    const score = await app!.inject({
      method: 'POST',
      url: '/v1/claims/score',
      headers: { authorization: s.authHeader },
      payload: {
        facilityId: s.facilityId,
        claim: {
          resourceType: 'Claim',
          patient: { identifier: { value: 'CR123456789-1' } },
          billablePeriod: { start: '2026-03-05' },
          item: [{ productOrService: { coding: [{ code: 'SVC-1' }], text: 'X' }, quantity: { value: 1 }, unitPrice: { value: 500 } }],
        },
      },
    });

    expect(score.statusCode).toBe(201);
    const decision = (score.json() as { data: { decision: string | null } }).data.decision;

    const deliveries = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND event_type = 'claim.flagged'`,
      [s.tenantId],
    );
    const count = Number.parseInt(deliveries.rows[0]?.count ?? '0', 10);

    if (decision === 'PASSED') {
      expect(count).toBe(0);
    } else {
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });
});
