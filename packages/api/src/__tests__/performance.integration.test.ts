import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getAdminPool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const currentDir = dirname(fileURLToPath(import.meta.url));
const testStoragePath = resolve(currentDir, '../../../.tmp-performance-storage');
const rulepacksDir = resolve(currentDir, '../../../../rulepacks');
const repoRootDir = resolve(currentDir, '../../../../');

const defaultRuns = parsePositiveInt(process.env.CLAIMFLOW_PERF_RUNS, 8);
const defaultPageCount = parsePositiveInt(process.env.CLAIMFLOW_PERF_PAGE_COUNT, 20);
const defaultMlPageDelayMs = parsePositiveInt(process.env.CLAIMFLOW_PERF_ML_PAGE_DELAY_MS, 10);
const deterministicSloMs = parsePositiveInt(process.env.CLAIMFLOW_PERF_SLO_DETERMINISTIC_MS, 2000);
const fullPipelineSloMs = parsePositiveInt(process.env.CLAIMFLOW_PERF_SLO_FULL_PIPELINE_MS, 20000);
const enforceSlo = process.env.CLAIMFLOW_PERF_ENFORCE_SLO === 'true';
const reportPath = process.env.CLAIMFLOW_PERF_REPORT_PATH;
const testTimeoutMs = parsePositiveInt(process.env.CLAIMFLOW_PERF_TIMEOUT_MS, 300000);

interface SeedContext {
  tenantId: string;
  facilityId: string;
  userId: string;
  authHeader: string;
}

interface MlStubController {
  baseUrl: string;
  registerDocument(documentId: string, pageCount: number): void;
  close(): Promise<void>;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function percentile(values: number[], percentileRank: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1),
  );

  return sorted[index] ?? 0;
}

function createAuthHeader(context: { tenantId: string; facilityId: string; userId: string }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: context.userId,
      tenantId: context.tenantId,
      facilityId: context.facilityId,
      role: 'claims_officer',
    }),
  ).toString('base64url');

  return `Bearer ${header}.${payload}.signature`;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, delayMs);
  });
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

function buildMlResponse(params: {
  documentId: string;
  docType: string;
  processingRoute: string;
  pageCount: number;
}): Record<string, unknown> {
  const pages = Array.from({ length: params.pageCount }, (_, index) => ({
    page_number: index + 1,
    status: 'COMPLETED',
    quality: {
      score: 0.92,
      blur_score: 0.9,
      skew_degrees: 0,
      dpi_estimated: 300,
    },
    ocr: {
      raw_text: `CLAIM PAGE ${index + 1}`,
      overall_confidence: 0.9,
      word_count: 3,
      engine: 'tesseract',
    },
    classification: {
      predicted_class: params.docType,
      confidence: 0.95,
      alternatives: [],
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
  }));

  return {
    document_id: params.documentId,
    doc_type: params.docType,
    processing_route: params.processingRoute,
    status: 'COMPLETED',
    processed_at: new Date().toISOString(),
    total_pages: params.pageCount,
    pages_processed: params.pageCount,
    pages_failed: 0,
    pages,
    aggregated_fields: [
      { field_key: 'patient_sha_id', value: 'CR123456789-1', confidence: 0.95 },
      { field_key: 'physician_signature_present', value: true, confidence: 0.9 },
      { field_key: 'physician_stamp_present', value: true, confidence: 0.85 },
      { field_key: 'claim_form_date', value: '2026-03-05', confidence: 0.9 },
      { field_key: 'admission_date', value: '2026-03-05', confidence: 0.9 },
      { field_key: 'patient_phone', value: '0700000000', confidence: 0.8 },
    ],
  };
}

async function startMlStubServer(perPageDelayMs: number): Promise<MlStubController> {
  const pageCountByDocument = new Map<string, number>();

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
    const pageCount = pageCountByDocument.get(documentId) ?? defaultPageCount;

    await sleep(perPageDelayMs * pageCount);

    respondJson(response, 200, buildMlResponse({
      documentId,
      docType,
      processingRoute,
      pageCount,
    }));
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
    registerDocument(documentId: string, pageCount: number) {
      pageCountByDocument.set(documentId, pageCount);
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
      // ignore unlock failures
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
    [tenantId, 'Performance Tenant', `tenant-${tenantId.slice(0, 8)}`],
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
      'performance.officer@example.org',
      'Performance Officer',
      '$2b$12$examplehashforintegrationtests000000000000000000',
    ],
  );

  return {
    tenantId,
    facilityId,
    userId,
    authHeader: createAuthHeader({ tenantId, facilityId, userId }),
  };
}

function createClaimPayload(facilityId: string, suffix: string): Record<string, unknown> {
  return {
    facilityId,
    claimType: 'OUTPATIENT',
    visitType: 'OP',
    patientShaId: `CR12345678${suffix}-1`,
    patientName: `Perf Patient ${suffix}`,
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
  const boundary = `----claimflow-perf-${randomUUID()}`;

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

async function uploadDocument(
  app: FastifyInstance,
  seed: SeedContext,
  claimId: string,
  pageCount: number,
): Promise<string> {
  const multipart = createMultipartPayload({
    docType: 'SHA_CLAIM_FORM_OP',
    filename: 'claim-form.pdf',
    contentType: 'application/pdf',
    fileBytes: createSimplePdf(pageCount),
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

  const body = response.json() as { data: { document: { id: string } } };
  return body.data.document.id;
}

integrationDescribe('Performance integration (SLO benchmark)', () => {
  let app: FastifyInstance | undefined;
  let pool: Pool | undefined;
  let config: Config;
  let mlStub: MlStubController;

  beforeAll(async () => {
    if (!integrationDatabaseUrl) {
      throw new Error('Integration database URL missing');
    }

    mlStub = await startMlStubServer(defaultMlPageDelayMs);

    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: integrationDatabaseUrl,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        RATE_LIMIT_RPM: '1000',
        STORAGE_PATH: testStoragePath,
        MAX_UPLOAD_SIZE_MB: '4',
        MAX_PAGES_PER_DOCUMENT: String(Math.max(defaultPageCount, 20)),
        ML_SERVICE_URL: mlStub.baseUrl,
        ML_TIMEOUT_MS: String(Math.max(defaultMlPageDelayMs * defaultPageCount * 4, 10000)),
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

  it('measures deterministic and full-pipeline p95 latency', async () => {
    const deterministicSamplesMs: number[] = [];
    const fullPipelineSamplesMs: number[] = [];

    for (let run = 1; run <= defaultRuns; run += 1) {
      const suffix = String(run).padStart(2, '0');
      const seed = await seedBaseData(pool!);
      const claimId = await createClaim(app!, seed, suffix);
      const documentId = await uploadDocument(app!, seed, claimId, defaultPageCount);
      mlStub.registerDocument(documentId, defaultPageCount);

      const startedAt = process.hrtime.bigint();

      const response = await app!.inject({
        method: 'POST',
        url: `/v1/claims/${claimId}/audit`,
        headers: {
          authorization: seed.authHeader,
        },
        payload: {},
      });

      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        data: {
          auditSession: {
            executionTimeMs: number;
          };
        };
      };

      expect(typeof body.data.auditSession.executionTimeMs).toBe('number');

      deterministicSamplesMs.push(body.data.auditSession.executionTimeMs);
      fullPipelineSamplesMs.push(elapsedMs);
    }

    const summary = {
      runs: defaultRuns,
      pagesPerDocument: defaultPageCount,
      mlStubPerPageDelayMs: defaultMlPageDelayMs,
      deterministic: {
        p50Ms: percentile(deterministicSamplesMs, 50),
        p95Ms: percentile(deterministicSamplesMs, 95),
      },
      fullPipeline: {
        p50Ms: percentile(fullPipelineSamplesMs, 50),
        p95Ms: percentile(fullPipelineSamplesMs, 95),
      },
      slo: {
        deterministicP95Ms: deterministicSloMs,
        fullPipelineP95Ms: fullPipelineSloMs,
        enforced: enforceSlo,
      },
    };

    console.info(`[performance] ${JSON.stringify(summary)}`);

    if (reportPath) {
      const absoluteReportPath = isAbsolute(reportPath)
        ? reportPath
        : resolve(repoRootDir, reportPath);
      await mkdir(dirname(absoluteReportPath), { recursive: true });
      await writeFile(absoluteReportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    }

    if (!enforceSlo) {
      expect(summary.deterministic.p95Ms).toBeGreaterThanOrEqual(0);
      expect(summary.fullPipeline.p95Ms).toBeGreaterThanOrEqual(0);
      return;
    }

    expect(summary.deterministic.p95Ms).toBeLessThanOrEqual(deterministicSloMs);
    expect(summary.fullPipeline.p95Ms).toBeLessThanOrEqual(fullPipelineSloMs);
  }, testTimeoutMs);
});

