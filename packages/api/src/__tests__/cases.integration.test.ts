import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CaseStatus, ErrorCode, WebhookEventType } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getPool, closePool } from '../db/client.js';
import { buildServer } from '../server.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

function adminAuthHeader(c: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: c.userId, tenantId: c.tenantId, facilityId: c.facilityId, role: 'admin' }),
  ).toString('base64url');
  return `Bearer ${header}.${payload}.signature`;
}

async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = resolve(currentDir, '../../../../migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
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
    'Case Tenant',
    `tenant-${tenantId.slice(0, 8)}`,
  ]);
  await pool.query(
    `INSERT INTO facilities (id, tenant_id, name, sha_facility_code, sha_provider_id, tier_level, county, is_active)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,true)`,
    [facilityId, tenantId, 'Case Facility', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );
  await pool.query(
    `INSERT INTO users (id, tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'admin'::user_role,true,false)`,
    [userId, tenantId, facilityId, `case.admin+${userId.slice(0, 8)}@example.org`, 'Case Admin', '$2b$12$examplehashforintegrationtests000000000000000000'],
  );
  return { tenantId, facilityId, userId, authHeader: adminAuthHeader({ tenantId, facilityId, userId }) };
}

async function createClaim(app: FastifyInstance, s: SeedContext, suffix: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    headers: { authorization: s.authHeader },
    payload: {
      facilityId: s.facilityId,
      claimType: 'OUTPATIENT',
      visitType: 'OP',
      patientShaId: `CR12345678${suffix}-1`,
      admissionDate: '2026-03-05',
      primaryDiagnosisCode: `D${suffix}`,
      lines: [{ shaServiceCode: `SVC-${suffix}`, description: 'Consult', quantity: 1, unitPrice: 500 }],
    },
  });
  return (response.json() as { data: { claim: { id: string } } }).data.claim.id;
}

integrationDescribe('Case management integration (real Postgres)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }
    config = loadConfig({
      exitOnError: false,
      env: { DATABASE_URL: integrationDatabaseUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RATE_LIMIT_RPM: '1000' },
    });
    pool = getPool(config);
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

  it('creates a case with linked claims and records a CASE_CREATED event', async () => {
    const s = await seed(pool!);
    const claimId = await createClaim(app!, s, 'A');

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: s.authHeader },
      payload: { title: 'Suspicious duplicate billing', priority: 'HIGH', claimIds: [claimId] },
    });

    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      data: { id: string; status: string; priority: string; linkedClaims: Array<{ claimId: string }> };
    };
    expect(body.data.status).toBe(CaseStatus.OPEN);
    expect(body.data.priority).toBe('HIGH');
    expect(body.data.linkedClaims.map((l) => l.claimId)).toEqual([claimId]);

    const detail = await app!.inject({
      method: 'GET',
      url: `/v1/cases/${body.data.id}`,
      headers: { authorization: s.authHeader },
    });
    const detailBody = detail.json() as { data: { events: Array<{ action: string }> } };
    expect(detailBody.data.events.some((e) => e.action === 'CASE_CREATED')).toBe(true);
  });

  it('enforces the status transition state machine', async () => {
    const s = await seed(pool!);
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: s.authHeader },
      payload: { title: 'Case' },
    });
    const caseId = (created.json() as { data: { id: string } }).data.id;

    const invalid = await app!.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/transition`,
      headers: { authorization: s.authHeader },
      payload: { status: 'CLOSED' },
    });
    expect(invalid.statusCode).toBe(422);
    expect((invalid.json() as { errors: Array<{ code: string }> }).errors[0]?.code).toBe(
      ErrorCode.INVALID_STATE_TRANSITION,
    );

    const valid = await app!.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/transition`,
      headers: { authorization: s.authHeader },
      payload: { status: 'INVESTIGATING', note: 'starting' },
    });
    expect(valid.statusCode).toBe(200);
    expect((valid.json() as { data: { status: string } }).data.status).toBe(CaseStatus.INVESTIGATING);
  });

  it('emits case.status_changed to a subscribed webhook endpoint', async () => {
    const s = await seed(pool!);
    await app!.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: { authorization: s.authHeader },
      payload: { url: 'https://example.test/hook', events: [WebhookEventType.CASE_STATUS_CHANGED] },
    });

    const created = await app!.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: s.authHeader },
      payload: { title: 'Case' },
    });
    const caseId = (created.json() as { data: { id: string } }).data.id;

    await app!.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/transition`,
      headers: { authorization: s.authHeader },
      payload: { status: 'INVESTIGATING' },
    });

    const deliveries = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM webhook_deliveries
        WHERE tenant_id = $1::uuid AND event_type = 'case.status_changed'`,
      [s.tenantId],
    );
    expect(Number.parseInt(deliveries.rows[0]?.count ?? '0', 10)).toBeGreaterThanOrEqual(1);
  });

  it('links and unlinks claims with audit events', async () => {
    const s = await seed(pool!);
    const claimId = await createClaim(app!, s, 'B');
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: s.authHeader },
      payload: { title: 'Case' },
    });
    const caseId = (created.json() as { data: { id: string } }).data.id;

    const linked = await app!.inject({
      method: 'POST',
      url: `/v1/cases/${caseId}/claims`,
      headers: { authorization: s.authHeader },
      payload: { claimIds: [claimId] },
    });
    expect(linked.statusCode).toBe(200);
    expect((linked.json() as { data: { linkedClaims: unknown[] } }).data.linkedClaims).toHaveLength(1);

    const unlinked = await app!.inject({
      method: 'DELETE',
      url: `/v1/cases/${caseId}/claims/${claimId}`,
      headers: { authorization: s.authHeader },
    });
    expect(unlinked.statusCode).toBe(204);
  });

  it('isolates cases by tenant', async () => {
    const s = await seed(pool!);
    const other = await seed(pool!);
    const created = await app!.inject({
      method: 'POST',
      url: '/v1/cases',
      headers: { authorization: s.authHeader },
      payload: { title: 'Tenant A case' },
    });
    const caseId = (created.json() as { data: { id: string } }).data.id;

    const crossTenant = await app!.inject({
      method: 'GET',
      url: `/v1/cases/${caseId}`,
      headers: { authorization: other.authHeader },
    });
    expect(crossTenant.statusCode).toBe(404);
  });
});
