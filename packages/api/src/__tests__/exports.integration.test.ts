import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getAdminPool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const currentDir = dirname(fileURLToPath(import.meta.url));
const testStoragePath = resolve(currentDir, '../../../.tmp-export-storage');
const rulepacksDir = resolve(currentDir, '../../../../rulepacks');

type MlStubMode = 'success';

interface MlStubController {
  baseUrl: string;
  setMode(mode: MlStubMode): void;
  close(): Promise<void>;
}

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  authHeader: string;
}

interface ExportStatusPayload {
  type: 'EXPORT';
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  outputFileName: string | null;
  outputPath: string | null;
  error: string | null;
}

function createAuthHeader(context: { tenantId: string; facilityId: string; userId: string; mfaVerifiedAt?: number }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: context.userId,
      tenantId: context.tenantId,
      facilityId: context.facilityId,
      role: 'claims_officer',
      mfaVerifiedAt: context.mfaVerifiedAt,
    }),
  ).toString('base64url');

  return `Bearer ${header}.${payload}.signature`;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');
  if (body.trim().length === 0) {
    return {};
  }

  return JSON.parse(body) as Record<string, unknown>;
}

function respondJson(response: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

async function startMlStubServer(): Promise<MlStubController> {
  let mode: MlStubMode = 'success';

  const server: Server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/ml/process-document') {
      response.statusCode = 404;
      response.end('not_found');
      return;
    }

    const requestBody = await readJsonBody(request);
    const documentId = String(requestBody.document_id ?? randomUUID());
    const docType = String(requestBody.doc_type ?? 'SHA_CLAIM_FORM_OP');
    const processingRoute = String(requestBody.processing_route ?? 'FULL_OCR_EXTRACT');

    if (mode === 'success') {
      respondJson(response, 200, {
        document_id: documentId,
        doc_type: docType,
        processing_route: processingRoute,
        status: 'COMPLETED',
        processed_at: new Date().toISOString(),
        total_pages: 1,
        pages_processed: 1,
        pages_failed: 0,
        pages: [
          {
            page_number: 1,
            status: 'COMPLETED',
            quality: { score: 0.92 },
            ocr: {
              raw_text: 'CLAIM FORM DIAGNOSIS treatment plan',
              overall_confidence: 0.91,
              word_count: 5,
              engine: 'tesseract',
            },
            extracted_fields: [
              { field_key: 'patient_sha_id', value: 'CR123456789-1', confidence: 0.95 },
              { field_key: 'claim_form_date', value: '2026-03-05', confidence: 0.9 },
              { field_key: 'admission_date', value: '2026-03-05', confidence: 0.9 },
            ],
            signature: {
              type: 'SIGNATURE',
              present: true,
              confidence: 0.88,
              bbox: { x: 100, y: 100, w: 200, h: 60 },
            },
          },
        ],
        aggregated_fields: [
          { field_key: 'patient_sha_id', value: 'CR123456789-1', confidence: 0.95 },
          { field_key: 'physician_signature_present', value: true, confidence: 0.9 },
          { field_key: 'physician_stamp_present', value: true, confidence: 0.85 },
          { field_key: 'claim_form_date', value: '2026-03-05', confidence: 0.9 },
          { field_key: 'admission_date', value: '2026-03-05', confidence: 0.9 },
          { field_key: 'patient_phone', value: '0700000000', confidence: 0.8 },
        ],
      });
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.listen(0, '127.0.0.1', (error?: Error) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      resolvePromise();
    });
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Unable to resolve ML stub server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setMode(nextMode: MlStubMode) {
      mode = nextMode;
    },
    close() {
      return new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error) {
            rejectPromise(error);
            return;
          }

          resolvePromise();
        });
      });
    },
  };
}

async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = resolve(currentDir, '../../../../migrations');
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  const migrationLockKey = 951337;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [migrationLockKey]);

    for (const file of files) {
      const sql = await readFile(resolve(migrationsDir, file), 'utf8');
      await client.query(sql);
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [migrationLockKey]);
    } catch {
      // ignore unlock errors
    }

    client.release();
  }
}

async function truncatePublicTables(pool: Pool): Promise<void> {
  const tableRows = await pool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('schema_migrations', 'payers', 'icd_codes', 'sha_service_codes')`,
  );

  if (tableRows.rows.length === 0) {
    return;
  }

  const tableList = tableRows.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

async function resetStoragePath(): Promise<void> {
  await rm(testStoragePath, { recursive: true, force: true });
  await mkdir(testStoragePath, { recursive: true });
}

async function seedBaseData(pool: Pool): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();

  await pool.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3)`,
    [tenantId, 'Export Tenant', `tenant-${tenantId.slice(0, 8)}`],
  );

  await pool.query(
    `INSERT INTO facilities (
        id,
        tenant_id,
        name,
        sha_facility_code,
        sha_provider_id,
        tier_level,
        county,
        is_active
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3,
        $4,
        $5,
        $6,
        $7,
        true
      )`,
    [facilityId, tenantId, 'Mary Help Mission', 'FID-22-106718-4', '000210', 'LEVEL_4', 'Kiambu'],
  );

  await pool.query(
    `INSERT INTO users (
        id,
        tenant_id,
        facility_id,
        email,
        display_name,
        password_hash,
        role,
        is_active,
        must_change_password
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4,
        $5,
        $6,
        'claims_officer'::user_role,
        true,
        false
      )`,
    [
      userId,
      tenantId,
      facilityId,
      'export.officer@example.org',
      'Export Officer',
      '$2b$12$examplehashforintegrationtests000000000000000000',
    ],
  );

  return {
    tenantId,
    facilityId,
    userId,
    authHeader: createAuthHeader({
      tenantId,
      facilityId,
      userId,
      mfaVerifiedAt: Date.now(),
    }),
  };
}

function createClaimPayload(facilityId: string, suffix: string): Record<string, unknown> {
  return {
    facilityId,
    claimType: 'OUTPATIENT',
    visitType: 'OP',
    patientShaId: `CR12345678${suffix}-1`,
    patientName: `Patient ${suffix}`,
    patientNationalId: `ID-${suffix}`,
    hmisRef: `HMIS-${suffix}`,
    admissionDate: '2026-03-05',
    primaryDiagnosisCode: `D${suffix}`,
    shaBenefitPackage: 'SHA-BASE',
    lines: [
      {
        shaServiceCode: `SVC-${suffix}`,
        description: 'Consultation',
        quantity: 1,
        unitPrice: 500,
      },
    ],
  };
}

async function createClaim(app: FastifyInstance, seed: SeedContext, suffix: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    headers: {
      authorization: seed.authHeader,
    },
    payload: createClaimPayload(seed.facilityId, suffix),
  });

  expect(response.statusCode).toBe(201);

  const body = response.json() as { data: { claim: { id: string } } };
  return body.data.claim.id;
}

function createSimplePdf(pageCount: number): Buffer {
  const pageMarkers = Array.from({ length: pageCount }, () => '<< /Type /Page >>').join('\n');
  return Buffer.from(`%PDF-1.4\n${pageMarkers}\n%%EOF`, 'utf8');
}

function createMultipartPayload(params: {
  docType: string;
  filename: string;
  contentType: string;
  fileBytes: Buffer;
}): { body: Buffer; contentType: string } {
  const boundary = `----claimflow-export-${randomUUID()}`;

  const chunks: Buffer[] = [
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="docType"\r\n\r\n'),
    Buffer.from(`${params.docType}\r\n`),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${params.filename}"\r\n`),
    Buffer.from(`Content-Type: ${params.contentType}\r\n\r\n`),
    params.fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadDocument(app: FastifyInstance, seed: SeedContext, claimId: string): Promise<void> {
  const multipart = createMultipartPayload({
    docType: 'SHA_CLAIM_FORM_OP',
    filename: 'claim-form.pdf',
    contentType: 'application/pdf',
    fileBytes: createSimplePdf(1),
  });

  const response = await app.inject({
    method: 'POST',
    url: `/v1/claims/${claimId}/documents`,
    headers: {
      authorization: seed.authHeader,
      'content-type': multipart.contentType,
    },
    payload: multipart.body,
  });

  expect(response.statusCode).toBe(201);
}

async function runAudit(app: FastifyInstance, seed: SeedContext, claimId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/claims/${claimId}/audit`,
    headers: {
      authorization: seed.authHeader,
    },
    payload: {},
  });

  expect(response.statusCode).toBe(200);

  const body = response.json() as { data: { auditSession: { id: string } } };
  return body.data.auditSession.id;
}

async function waitForExportCompletion(
  app: FastifyInstance,
  authHeader: string,
  jobId: string,
): Promise<ExportStatusPayload> {
  const timeoutAt = Date.now() + 30_000;

  while (Date.now() < timeoutAt) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}`,
      headers: {
        authorization: authHeader,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as { data: ExportStatusPayload };

    if (body.data.status === 'COMPLETED' || body.data.status === 'FAILED') {
      return body.data;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }

  throw new Error(`Timed out waiting for export job ${jobId}`);
}

integrationDescribe('Evidence pack export integration', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;
  let mlStub: MlStubController;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }

    mlStub = await startMlStubServer();

    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: integrationDatabaseUrl,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '1000',
        STORAGE_PATH: testStoragePath,
        MAX_UPLOAD_SIZE_MB: '2',
        MAX_PAGES_PER_DOCUMENT: '10',
        ML_SERVICE_URL: mlStub.baseUrl,
        ML_TIMEOUT_MS: '3000',
        RULEPACK_DIR: rulepacksDir,
      },
    });

    pool = getAdminPool(config);
    await pool.query('SELECT 1');
    await runMigrations(pool);

    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) {
      throw new Error('Pool not initialized');
    }

    mlStub.setMode('success');
    await truncatePublicTables(pool);
    await resetStoragePath();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    await closePool();
    await rm(testStoragePath, { recursive: true, force: true });
    await mlStub.close();
  });

  it('POST export enqueues job, generates evidence pack, and downloads ZIP', { timeout: 40_000 }, async () => {
    const seed = await seedBaseData(pool!);
    const claimId = await createClaim(app!, seed, '71');

    await uploadDocument(app!, seed, claimId);
    const auditSessionId = await runAudit(app!, seed, claimId);

    const enqueue = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/export`,
      headers: {
        authorization: seed.authHeader,
      },
      payload: {
        auditSessionId,
      },
    });

    expect(enqueue.statusCode).toBe(202);

    const enqueueBody = enqueue.json() as {
      data: {
        jobId: string;
        claimId: string;
        auditSessionId: string;
        status: string;
      };
    };

    expect(enqueueBody.data.claimId).toBe(claimId);
    expect(enqueueBody.data.auditSessionId).toBe(auditSessionId);
    expect(enqueueBody.data.status).toBe('QUEUED');

    const status = await waitForExportCompletion(app!, seed.authHeader, enqueueBody.data.jobId);
    expect(status.type).toBe('EXPORT');
    expect(status.status).toBe('COMPLETED');
    expect(status.outputFileName).toBeTruthy();
    expect(status.outputPath).toBeTruthy();

    const download = await app!.inject({
      method: 'GET',
      url: `/v1/exports/${enqueueBody.data.jobId}/download`,
      headers: {
        authorization: seed.authHeader,
      },
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/zip');
    expect(download.rawPayload.length).toBeGreaterThan(4);
    expect(download.rawPayload.subarray(0, 2).toString('utf8')).toBe('PK');

    const auditTrail = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_trail
        WHERE tenant_id = $1::uuid
          AND claim_id = $2::uuid
          AND action = 'CLAIM_EXPORTED'::audit_action`,
      [seed.tenantId, claimId],
    );

    expect(Number.parseInt(auditTrail.rows[0]?.count ?? '0', 10)).toBe(1);

    const sessionRow = await pool!.query<{ fix_report_pdf_path: string | null }>(
      `SELECT fix_report_pdf_path
         FROM audit_sessions
        WHERE id = $1::uuid`,
      [auditSessionId],
    );

    expect(sessionRow.rows[0]?.fix_report_pdf_path).toBeTruthy();
    expect(sessionRow.rows[0]?.fix_report_pdf_path).toBe(status.outputPath);

    const zipBytes = await readFile(status.outputPath!);
    expect(zipBytes.length).toBeGreaterThan(4);
    expect(zipBytes.subarray(0, 2).toString('utf8')).toBe('PK');
  });

  it('export without an audit session returns 400 VALIDATION_ERROR', async () => {
    const seed = await seedBaseData(pool!);
    const claimId = await createClaim(app!, seed, '72');

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/export`,
      headers: {
        authorization: seed.authHeader,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);

    const body = response.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('download endpoint returns 404 for unknown export job', async () => {
    const seed = await seedBaseData(pool!);

    const response = await app!.inject({
      method: 'GET',
      url: `/v1/exports/${randomUUID()}/download`,
      headers: {
        authorization: seed.authHeader,
      },
    });

    expect(response.statusCode).toBe(404);

    const body = response.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.NOT_FOUND);
  });
});