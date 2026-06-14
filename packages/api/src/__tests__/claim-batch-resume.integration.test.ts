import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { getAdminPool, getTenantDb, runWithTenant, closePool } from '../db/client.js';
import { createProcessClaimBatchHandler } from '../jobs/handlers/process-claim-batch.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rulepacksDir = resolve(currentDir, '../../../../rulepacks');
const ownerUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof ownerUrl === 'string' && ownerUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;
const APP_PASSWORD = 'batch_resume_app_pw';

function appUrl(): string {
  const base = new URL(ownerUrl as string);
  base.username = 'claimflow_app';
  base.password = APP_PASSWORD;
  return base.toString();
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
  if (rows.rows.length === 0) return;
  await pool.query(`TRUNCATE TABLE ${rows.rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

function fhirClaim(facilityId: string, suffix: string): Record<string, unknown> {
  return {
    facilityId,
    claim: {
      resourceType: 'Claim',
      use: 'claim',
      patient: { identifier: { value: `CR12345678${suffix}-1` } },
      type: { coding: [{ code: 'OUTPATIENT' }] },
      billablePeriod: { start: '2026-03-05' },
      item: [{ sequence: 1, productOrService: { coding: [{ code: `SVC-${suffix}` }], text: 'Consult' }, quantity: { value: 1 }, unitPrice: { value: 500 } }],
    },
  };
}

integrationDescribe('Claim batch worker resumability (app role under RLS)', () => {
  let ownerPool: Pool | undefined;
  let config: Config;
  let tenantId: string;
  let facilityId: string;
  let userId: string;
  let batchId: string;

  beforeAll(async () => {
    if (!ownerUrl) throw new Error('Integration database URL missing');
    ownerPool = getAdminPool(loadConfig({ exitOnError: false, env: { DATABASE_URL: ownerUrl, NODE_ENV: 'test', LOG_LEVEL: 'silent', RULEPACK_DIR: rulepacksDir } }));
    await runMigrations(ownerPool);
    await ownerPool.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claimflow_app') THEN
           CREATE ROLE claimflow_app NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '${APP_PASSWORD}';
         ELSE ALTER ROLE claimflow_app LOGIN PASSWORD '${APP_PASSWORD}'; END IF;
       END $$;`,
    );
    config = loadConfig({
      exitOnError: false,
      env: { DATABASE_URL: ownerUrl, APP_DATABASE_URL: appUrl(), NODE_ENV: 'test', LOG_LEVEL: 'silent', RULEPACK_DIR: rulepacksDir },
    });
  });

  beforeEach(async () => {
    await truncate(ownerPool!);
    tenantId = randomUUID();
    facilityId = randomUUID();
    userId = randomUUID();
    batchId = randomUUID();
    await ownerPool!.query(`INSERT INTO tenants (id,name,slug) VALUES ($1::uuid,$2,$3)`, [tenantId, 'Resume', `t-${tenantId.slice(0, 8)}`]);
    await ownerPool!.query(
      `INSERT INTO facilities (id,tenant_id,name,sha_facility_code,sha_provider_id,tier_level,county,is_active)
       VALUES ($1::uuid,$2::uuid,'F','FID-22-106718-4','000210','LEVEL_4','Kiambu',true)`,
      [facilityId, tenantId],
    );
    await ownerPool!.query(
      `INSERT INTO users (id,tenant_id,facility_id,email,display_name,password_hash,role,is_active,must_change_password)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'U','h','claims_officer'::user_role,true,false)`,
      [userId, tenantId, facilityId, `r+${userId.slice(0, 8)}@x.io`],
    );
    // A batch of 3 with item 0 already SCORED and item 1 already FAILED (as if a
    // prior run crashed after them); only item 2 remains QUEUED.
    await ownerPool!.query(
      `INSERT INTO claim_batches (id,tenant_id,status,total_claims,processed_count,created_by)
       VALUES ($1::uuid,$2::uuid,'PROCESSING',3,2,$3::uuid)`,
      [batchId, tenantId, userId],
    );
    await ownerPool!.query(
      `INSERT INTO claim_batch_items (batch_id,tenant_id,item_index,status,claim_id,score_json)
       VALUES ($1::uuid,$2::uuid,0,'SCORED',$3::uuid,'{"claimId":"x"}'::jsonb)`,
      [batchId, tenantId, randomUUID()],
    );
    await ownerPool!.query(
      `INSERT INTO claim_batch_items (batch_id,tenant_id,item_index,status,error_code,error_message)
       VALUES ($1::uuid,$2::uuid,1,'FAILED','VALIDATION_ERROR','bad')`,
      [batchId, tenantId],
    );
    await ownerPool!.query(
      `INSERT INTO claim_batch_items (batch_id,tenant_id,item_index,status) VALUES ($1::uuid,$2::uuid,2,'QUEUED')`,
      [batchId, tenantId],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('resumes a partially-processed batch: scores only the still-QUEUED item, leaves the others, converges to terminal', async () => {
    const claims = [fhirClaim(facilityId, '0'), fhirClaim(facilityId, '1'), fhirClaim(facilityId, '2')] as never;

    await runWithTenant(tenantId, async () => {
      const handler = createProcessClaimBatchHandler({
        logger: { warn() {}, info() {}, error() {}, debug() {} } as never,
        config,
        tenantDb: getTenantDb(config),
      });
      const result = await handler({ jobId: 'resume-test', data: { batchId, tenantId, requestedByUserId: userId, claims } });
      // This invocation only processed the one still-QUEUED item.
      expect(result.scored).toBe(1);
      expect(result.failed).toBe(0);
    });

    // Item 0 still SCORED (not re-scored), item 1 still FAILED, item 2 now SCORED.
    const items = await ownerPool!.query<{ item_index: number; status: string }>(
      `SELECT item_index, status FROM claim_batch_items WHERE batch_id = $1::uuid ORDER BY item_index`,
      [batchId],
    );
    expect(items.rows.map((r) => r.status)).toEqual(['SCORED', 'FAILED', 'SCORED']);

    // Batch converges to a terminal status (recomputed from rows: 2 scored, 1 failed).
    const batch = await ownerPool!.query<{ status: string; processed_count: number }>(
      `SELECT status, processed_count FROM claim_batches WHERE id = $1::uuid`,
      [batchId],
    );
    expect(batch.rows[0]?.status).toBe('COMPLETED_WITH_ERRORS');
    expect(batch.rows[0]?.processed_count).toBe(3);

    // Metering: only the ONE newly-scored claim was billed (item 0 not re-metered).
    const counter = await ownerPool!.query<{ total: string }>(
      `SELECT COALESCE(SUM(request_count),0)::text AS total FROM usage_counters WHERE tenant_id = $1::uuid AND route_class = 'batch'`,
      [tenantId],
    );
    expect(Number(counter.rows[0]?.total)).toBe(1);
  });
});
