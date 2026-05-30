import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@claimflow/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { closePool, getPool } from '../db/client.js';
import { buildServer } from '../server.js';

const integrationDatabaseUrl = process.env.CLAIMFLOW_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runIntegration = typeof integrationDatabaseUrl === 'string' && integrationDatabaseUrl.length > 0;
const integrationDescribe = runIntegration ? describe : describe.skip;

const currentDir = dirname(fileURLToPath(import.meta.url));

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
        AND tablename <> 'schema_migrations'`,
  );

  if (tableRows.rows.length === 0) {
    return;
  }

  const tableList = tableRows.rows.map((row) => `"${row.tablename}"`).join(', ');
  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

async function seedBaseData(pool: Pool, suffix: string): Promise<SeedContext> {
  const tenantId = randomUUID();
  const facilityId = randomUUID();
  const userId = randomUUID();

  await pool.query(
    `INSERT INTO tenants (id, name, slug)
     VALUES ($1::uuid, $2, $3)`,
    [tenantId, `Extraction Tenant ${suffix}`, `tenant-${suffix}-${tenantId.slice(0, 8)}`],
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
    [facilityId, tenantId, `Facility ${suffix}`, `FID-22-106718-${suffix}`, `00021${suffix}`, 'LEVEL_4', 'Kiambu'],
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
      `extract.${suffix}@example.org`,
      `Extract Officer ${suffix}`,
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

async function seedExtractionArtifacts(
  pool: Pool,
  params: {
    claimId: string;
    userId: string;
    fieldValue?: string;
  },
): Promise<{ documentId: string; fieldId: string; secondaryFieldId: string }> {
  const documentId = randomUUID();
  const fieldId = randomUUID();
  const secondaryFieldId = randomUUID();

  await pool.query(
    `INSERT INTO documents (
        id,
        claim_id,
        doc_type,
        processing_route,
        mime_type,
        original_filename,
        page_count,
        file_size_bytes,
        storage_path,
        sha256,
        processing_status,
        uploaded_by
      ) VALUES (
        $1::uuid,
        $2::uuid,
        'SHA_CLAIM_FORM_OP'::doc_type,
        'FULL_OCR_EXTRACT'::doc_processing_route,
        'application/pdf',
        'claim-form.pdf',
        1,
        1024,
        '/tmp/claim-form.pdf',
        'abc123',
        'COMPLETED'::doc_processing_status,
        $3::uuid
      )`,
    [documentId, params.claimId, params.userId],
  );

  await pool.query(
    `INSERT INTO document_pages (
        document_id,
        page_number,
        status,
        ocr_engine_used,
        overall_confidence,
        image_quality_score,
        processed_at
      ) VALUES (
        $1::uuid,
        1,
        'COMPLETED'::doc_processing_status,
        'tesseract',
        0.91,
        0.93,
        now()
      )`,
    [documentId],
  );

  await pool.query(
    `INSERT INTO ocr_text (
        document_id,
        page_number,
        raw_text,
        engine,
        overall_confidence,
        word_count
      ) VALUES (
        $1::uuid,
        1,
        $2,
        'tesseract',
        0.91,
        9
      )`,
    [documentId, 'PATIENT ID CR123456789-1 diagnosis malaria treatment plan'],
  );

  await pool.query(
    `INSERT INTO extracted_fields (
        id,
        claim_id,
        document_id,
        page_number,
        field_key,
        field_value,
        confidence,
        confidence_tier,
        bbox_json,
        source,
        needs_review,
        reviewed
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        1,
        'patient_sha_id',
        'CR123456789-1',
        0.96,
        'HIGH'::field_confidence_tier,
        $4::jsonb,
        'OCR',
        false,
        false
      ), (
        $5::uuid,
        $2::uuid,
        $3::uuid,
        1,
        'diagnosis',
        $6,
        0.72,
        'MEDIUM'::field_confidence_tier,
        NULL,
        'OCR',
        true,
        false
      )`,
    [
      fieldId,
      params.claimId,
      documentId,
      JSON.stringify({ x: 12, y: 34, w: 120, h: 40 }),
      secondaryFieldId,
      params.fieldValue ?? 'malaria',
    ],
  );

  return {
    documentId,
    fieldId,
    secondaryFieldId,
  };
}

integrationDescribe('Extraction + correction integration (real Postgres)', () => {
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
      },
    });

    pool = getPool(config);
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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    await closePool();
  });

  it('Get extraction for a processed page returns OCR + fields', async () => {
    const seed = await seedBaseData(pool!, '41');
    const claimId = await createDraftClaim(app!, seed, '41');
    const artifacts = await seedExtractionArtifacts(pool!, {
      claimId,
      userId: seed.userId,
    });

    const response = await app!.inject({
      method: 'GET',
      url: `/v1/documents/${artifacts.documentId}/pages/1/extraction`,
      headers: {
        authorization: seed.authHeader,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      data: {
        documentId: string;
        pageNumber: number;
        ocr: {
          rawText: string | null;
          confidence: number | null;
        };
        fields: Array<{ fieldKey: string; confidenceTier: string }>;
      };
    };

    expect(body.data.documentId).toBe(artifacts.documentId);
    expect(body.data.pageNumber).toBe(1);
    expect(body.data.ocr.rawText).toContain('diagnosis malaria');
    expect(body.data.ocr.confidence).toBe(0.91);
    expect(body.data.fields).toHaveLength(2);
    expect(body.data.fields.some((field) => field.fieldKey === 'patient_sha_id')).toBe(true);
    expect(body.data.fields.some((field) => field.confidenceTier === 'MEDIUM')).toBe(true);
  });

  it('Correct field stores correction and updates extracted field', async () => {
    const seed = await seedBaseData(pool!, '42');
    const claimId = await createDraftClaim(app!, seed, '42');
    const artifacts = await seedExtractionArtifacts(pool!, {
      claimId,
      userId: seed.userId,
      fieldValue: 'malaria',
    });

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/extracted-fields/${artifacts.secondaryFieldId}/correct`,
      headers: {
        authorization: seed.authHeader,
      },
      payload: {
        correctedValue: 'severe malaria',
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      data: {
        field: {
          id: string;
          value: string | null;
          source: string;
          reviewed: boolean;
          needsReview: boolean;
        };
      };
    };

    expect(body.data.field.id).toBe(artifacts.secondaryFieldId);
    expect(body.data.field.value).toBe('severe malaria');
    expect(body.data.field.source).toBe('MANUAL');
    expect(body.data.field.reviewed).toBe(true);
    expect(body.data.field.needsReview).toBe(false);

    const correctionRow = await pool!.query<{ corrected_value: string }>(
      `SELECT corrected_value
         FROM corrections
        WHERE extracted_field_id = $1::uuid
        LIMIT 1`,
      [artifacts.secondaryFieldId],
    );

    expect(correctionRow.rows[0]?.corrected_value).toBe('severe malaria');

    const extractedFieldRow = await pool!.query<{ field_value: string | null; source: string; reviewed: boolean }>(
      `SELECT field_value, source, reviewed
         FROM extracted_fields
        WHERE id = $1::uuid`,
      [artifacts.secondaryFieldId],
    );

    expect(extractedFieldRow.rows[0]?.field_value).toBe('severe malaria');
    expect(extractedFieldRow.rows[0]?.source).toBe('MANUAL');
    expect(extractedFieldRow.rows[0]?.reviewed).toBe(true);
  });

  it("Correcting a field in another tenant's claim returns 404", async () => {
    const owner = await seedBaseData(pool!, '43a');
    const outsider = await seedBaseData(pool!, '43b');

    const claimId = await createDraftClaim(app!, owner, '43');
    const artifacts = await seedExtractionArtifacts(pool!, {
      claimId,
      userId: owner.userId,
    });

    const response = await app!.inject({
      method: 'POST',
      url: `/v1/extracted-fields/${artifacts.secondaryFieldId}/correct`,
      headers: {
        authorization: outsider.authHeader,
      },
      payload: {
        correctedValue: 'blocked update',
      },
    });

    expect(response.statusCode).toBe(404);

    const body = response.json() as { errors: Array<{ code: ErrorCode }> };
    expect(body.errors[0]?.code).toBe(ErrorCode.NOT_FOUND);
  });
});
