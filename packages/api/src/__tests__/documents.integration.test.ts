import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClaimStatus, ErrorCode } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getAdminPool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const currentDir = dirname(fileURLToPath(import.meta.url));
const testStoragePath = resolve(currentDir, '../../../.tmp-doc-storage');

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

      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${file}`, {
          cause: error as Error,
        });
      }
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
    [tenantId, 'Document Tenant', `tenant-${tenantId.slice(0, 8)}`],
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
      'documents.officer@example.org',
      'Documents Officer',
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

function createMultipartPayload(params: {
  docType: string;
  filename: string;
  contentType: string;
  fileBytes: Buffer;
}): { body: Buffer; contentType: string } {
  const boundary = `----claimflow-${randomUUID()}`;

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

function createSimplePdf(pageCount: number): Buffer {
  const pageMarkers = Array.from({ length: pageCount }, () => '<< /Type /Page >>').join('\n');
  return Buffer.from(`%PDF-1.4\n${pageMarkers}\n%%EOF`, 'utf8');
}

async function createDraftClaim(app: FastifyInstance, seed: SeedContext, suffix: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/claims',
    headers: {
      authorization: seed.authHeader,
    },
    payload: {
      facilityId: seed.facilityId,
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
    },
  });

  expect(response.statusCode).toBe(201);

  const body = response.json() as { data: { claim: { id: string } } };
  return body.data.claim.id;
}

integrationDescribe('Document routes integration (real Postgres)', () => {
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
        STORAGE_PATH: testStoragePath,
        MAX_UPLOAD_SIZE_MB: '1',
        MAX_PAGES_PER_DOCUMENT: '5',
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
  });

  it('Upload PDF stores file, computes checksum, and counts pages', async () => {
    const seed = await seedBaseData(pool!);
    const claimId = await createDraftClaim(app!, seed, '11');

    const pdfBytes = createSimplePdf(2);
    const multipart = createMultipartPayload({
      docType: 'PHYSICIAN_NOTES',
      filename: 'notes.pdf',
      contentType: 'application/pdf',
      fileBytes: pdfBytes,
    });

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/documents`,
      headers: {
        authorization: seed.authHeader,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      data: {
        document: {
          id: string;
          pageCount: number;
          sha256: string;
          processingStatus: string;
          storagePath: string;
        };
        pages: Array<{ pageNumber: number }>;
      };
    };

    expect(body.data.document.pageCount).toBe(2);
    expect(body.data.document.processingStatus).toBe('PENDING');
    expect(body.data.pages).toHaveLength(2);
    expect(body.data.document.sha256).toBe(createHash('sha256').update(pdfBytes).digest('hex'));

    const docsInDb = await pool!.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM documents');
    const pagesInDb = await pool!.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM document_pages');

    expect(Number.parseInt(docsInDb.rows[0]?.count ?? '0', 10)).toBe(1);
    expect(Number.parseInt(pagesInDb.rows[0]?.count ?? '0', 10)).toBe(2);

    const statusRow = await pool!.query<{ status: ClaimStatus }>('SELECT status FROM claims WHERE id = $1::uuid', [claimId]);
    expect(statusRow.rows[0]?.status).toBe(ClaimStatus.DOCUMENTS_UPLOADED);

    const storedFile = await readFile(body.data.document.storagePath);
    expect(storedFile.equals(pdfBytes)).toBe(true);
  });

  it('Upload oversized file returns 413', async () => {
    const seed = await seedBaseData(pool!);
    const claimId = await createDraftClaim(app!, seed, '12');

    const largeFile = Buffer.alloc(1_048_580, 0x61);
    const multipart = createMultipartPayload({
      docType: 'PHYSICIAN_NOTES',
      filename: 'large.pdf',
      contentType: 'application/pdf',
      fileBytes: largeFile,
    });

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/documents`,
      headers: {
        authorization: seed.authHeader,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    });

    expect(response.statusCode).toBe(413);

    const body = response.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.FILE_TOO_LARGE);
  });

  it('Upload invalid MIME type returns 400', async () => {
    const seed = await seedBaseData(pool!);
    const claimId = await createDraftClaim(app!, seed, '13');

    const badFile = Buffer.from('this is not a supported binary document', 'utf8');
    const multipart = createMultipartPayload({
      docType: 'PHYSICIAN_NOTES',
      filename: 'notes.txt',
      contentType: 'text/plain',
      fileBytes: badFile,
    });

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/documents`,
      headers: {
        authorization: seed.authHeader,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    });

    expect(response.statusCode).toBe(400);

    const body = response.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('Upload to non-existent claim returns 404', async () => {
    const seed = await seedBaseData(pool!);

    const pdfBytes = createSimplePdf(1);
    const multipart = createMultipartPayload({
      docType: 'PHYSICIAN_NOTES',
      filename: 'notes.pdf',
      contentType: 'application/pdf',
      fileBytes: pdfBytes,
    });

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${randomUUID()}/documents`,
      headers: {
        authorization: seed.authHeader,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    });

    expect(response.statusCode).toBe(404);

    const body = response.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('Download with valid auth streams document bytes', async () => {
    const seed = await seedBaseData(pool!);
    const claimId = await createDraftClaim(app!, seed, '14');

    const pdfBytes = createSimplePdf(2);
    const multipart = createMultipartPayload({
      docType: 'PHYSICIAN_NOTES',
      filename: 'download-me.pdf',
      contentType: 'application/pdf',
      fileBytes: pdfBytes,
    });

    const upload = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/documents`,
      headers: {
        authorization: seed.authHeader,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    });

    expect(upload.statusCode).toBe(201);

    const uploadBody = upload.json() as { data: { document: { id: string } } };
    const documentId = uploadBody.data.document.id;

    const download = await app!.inject({
      method: 'GET',
      url: `/v1/documents/${documentId}/download`,
      headers: {
        authorization: seed.authHeader,
      },
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.rawPayload.equals(pdfBytes)).toBe(true);

    const auditRows = await pool!.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM audit_trail
        WHERE tenant_id = $1::uuid
          AND claim_id = $2::uuid
          AND action = 'DOCUMENT_DOWNLOADED'::audit_action`,
      [seed.tenantId, claimId],
    );

    expect(Number.parseInt(auditRows.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('First upload transitions claim from DRAFT to DOCUMENTS_UPLOADED', async () => {
    const seed = await seedBaseData(pool!);
    const claimId = await createDraftClaim(app!, seed, '15');

    const statusBefore = await pool!.query<{ status: ClaimStatus }>('SELECT status FROM claims WHERE id = $1::uuid', [claimId]);
    expect(statusBefore.rows[0]?.status).toBe(ClaimStatus.DRAFT);

    const pdfBytes = createSimplePdf(1);
    const multipart = createMultipartPayload({
      docType: 'PHYSICIAN_NOTES',
      filename: 'state-change.pdf',
      contentType: 'application/pdf',
      fileBytes: pdfBytes,
    });

    const upload = await app!.inject({
      method: 'POST',
      url: `/v1/claims/${claimId}/documents`,
      headers: {
        authorization: seed.authHeader,
        'content-type': multipart.contentType,
      },
      payload: multipart.body,
    });

    expect(upload.statusCode).toBe(201);

    const statusAfter = await pool!.query<{ status: ClaimStatus }>('SELECT status FROM claims WHERE id = $1::uuid', [claimId]);
    expect(statusAfter.rows[0]?.status).toBe(ClaimStatus.DOCUMENTS_UPLOADED);
  });
});
