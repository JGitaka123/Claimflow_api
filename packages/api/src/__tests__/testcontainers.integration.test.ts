import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ClaimStatus } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { closePool, getPool } from '../db/client.js';
import { loadConfig, type Config } from '../config.js';
import { buildServer } from '../server.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const testStoragePath = resolve(currentDir, '../../../.tmp-testcontainers-storage');
const rulepacksDir = resolve(currentDir, '../../../../rulepacks');

type MlStubMode = 'success' | 'partial' | 'error';

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

function buildMlSuccessResponse(requestBody: Record<string, unknown>): Record<string, unknown> {
  const documentId = String(requestBody.document_id ?? randomUUID());
  const docType = String(requestBody.doc_type ?? 'SHA_CLAIM_FORM_OP');
  const processingRoute = String(requestBody.processing_route ?? 'FULL_OCR_EXTRACT');

  return {
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
        quality: {
          score: 0.92,
          blur_score: 0.9,
          skew_degrees: 0,
          dpi_estimated: 300,
        },
        ocr: {
          raw_text: 'CLAIM FORM PATIENT ID CR123456789-1 DIAGNOSIS flu treatment plan',
          overall_confidence: 0.91,
          word_count: 10,
          engine: 'tesseract',
        },
        classification: {
          predicted_class: docType,
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
  };
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

    if (mode === 'error') {
      respondJson(response, 500, {
        detail: 'ml_failure',
      });
      return;
    }

    if (mode === 'partial') {
      respondJson(response, 200, {
        document_id: String(requestBody.document_id ?? randomUUID()),
        doc_type: String(requestBody.doc_type ?? 'SHA_CLAIM_FORM_OP'),
        processing_route: String(requestBody.processing_route ?? 'FULL_OCR_EXTRACT'),
        status: 'PARTIAL',
        processed_at: new Date().toISOString(),
        total_pages: 2,
        pages_processed: 1,
        pages_failed: 1,
        pages: [
          {
            page_number: 1,
            status: 'COMPLETED',
            quality: { score: 0.84 },
            ocr: {
              raw_text: 'CLAIM FORM PAGE ONE treatment plan diagnosis',
              overall_confidence: 0.86,
              word_count: 7,
              engine: 'tesseract',
            },
            extracted_fields: [{ field_key: 'patient_sha_id', value: 'CR123456789-1', confidence: 0.9 }],
            signature: {
              type: 'SIGNATURE',
              present: true,
              confidence: 0.8,
              bbox: { x: 80, y: 95, w: 210, h: 58 },
            },
          },
          {
            page_number: 2,
            status: 'FAILED',
            error: 'ocr_failure',
          },
        ],
        aggregated_fields: [{ field_key: 'patient_sha_id', value: 'CR123456789-1', confidence: 0.9 }],
      });
      return;
    }

    respondJson(response, 200, buildMlSuccessResponse(requestBody));
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
        AND tablename <> 'schema_migrations'`,
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
    [tenantId, 'Testcontainers Tenant', `tenant-${tenantId.slice(0, 8)}`],
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
      'claims.officer@example.org',
      'Claims Officer',
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
  const boundary = `----claimflow-testcontainers-${randomUUID()}`;

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

describe('Testcontainers full pipeline integration', () => {
  let postgres: StartedPostgreSqlContainer;
  let mlStub: MlStubController;
  let app: FastifyInstance;
  let pool: Pool;
  let config: Config;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('claimflow')
      .withUsername('claimflow')
      .withPassword('dev')
      .start();

    mlStub = await startMlStubServer();

    config = loadConfig({
      exitOnError: false,
      env: {
        DATABASE_URL: postgres.getConnectionUri(),
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

    pool = getPool(config);
    await pool.query('SELECT 1');
    await runMigrations(pool);

    app = buildServer({ config });
    await app.ready();
  });

  beforeEach(async () => {
    await truncatePublicTables(pool);
    await resetStoragePath();
    mlStub.setMode('success');
  });

  afterAll(async () => {
    await app.close();
    await closePool();
    await rm(testStoragePath, { recursive: true, force: true });
    await mlStub.close();
    await postgres.stop();
  });

  it('runs end-to-end create -> upload -> audit against containerized postgres', async () => {
    const seed = await seedBaseData(pool);
    const claimId = await createClaim(app, seed, 'tc-01');
    await uploadDocument(app, seed, claimId);

    const auditResponse = await app.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/audit`,
      headers: {
        authorization: seed.authHeader,
      },
      payload: {},
    });

    expect(auditResponse.statusCode).toBe(200);

    const auditBody = auditResponse.json() as {
      data: {
        auditSession: { id: string };
        ruleResults: unknown[];
      };
    };

    expect(auditBody.data.auditSession.id).toBeTruthy();
    expect(auditBody.data.ruleResults.length).toBeGreaterThan(0);

    const statusRow = await pool.query<{ status: ClaimStatus }>('SELECT status FROM claims WHERE id = $1::uuid', [claimId]);
    expect([ClaimStatus.PASSED, ClaimStatus.FAILED, ClaimStatus.WARNING]).toContain(statusRow.rows[0]?.status);

    const auditTrail = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_trail
        WHERE claim_id = $1::uuid
          AND action = 'AUDIT_COMPLETED'::audit_action`,
      [claimId],
    );

    expect(Number.parseInt(auditTrail.rows[0]?.count ?? '0', 10)).toBe(1);
  });
});
