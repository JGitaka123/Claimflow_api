import { DomainError, ErrorCode, type FieldConfidenceTier } from '@claimflow/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

interface GetPageExtractionParams {
  tenantId: string;
  documentId: string;
  pageNumber: number;
}

interface CorrectFieldParams {
  tenantId: string;
  userId: string;
  fieldId: string;
  correctedValue: string;
  requestId: string;
}

interface PageContextRow extends QueryResultRow {
  document_id: string;
  claim_id: string;
  processing_status: string;
  page_number: number | null;
  page_status: string | null;
  ocr_engine_used: string | null;
  page_confidence: number | null;
  image_quality_score: number | null;
}

interface OcrRow extends QueryResultRow {
  raw_text: string;
  engine: string;
  overall_confidence: number;
  word_count: number;
}

interface ExtractedFieldRow extends QueryResultRow {
  id: string;
  field_key: string;
  field_value: string | null;
  confidence: number;
  confidence_tier: FieldConfidenceTier;
  bbox_json: unknown;
  source: string;
  needs_review: boolean;
  reviewed: boolean;
  created_at: Date | string;
}

interface FieldForUpdateRow extends ExtractedFieldRow {
  claim_id: string;
  document_id: string;
  page_number: number;
  tenant_id: string;
}

interface CorrectionRow extends QueryResultRow {
  id: string;
  extracted_field_id: string;
  original_value: string | null;
  corrected_value: string;
  corrected_by: string;
  corrected_at: Date | string;
  used_for_training: boolean;
}

function toIsoString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function parseBbox(value: unknown): { x: number; y: number; w: number; h: number } | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { x?: unknown }).x !== 'number' ||
    typeof (value as { y?: unknown }).y !== 'number' ||
    typeof (value as { w?: unknown }).w !== 'number' ||
    typeof (value as { h?: unknown }).h !== 'number'
  ) {
    return null;
  }

  return {
    x: (value as { x: number }).x,
    y: (value as { y: number }).y,
    w: (value as { w: number }).w,
    h: (value as { h: number }).h,
  };
}

function mapExtractedField(row: ExtractedFieldRow): {
  id: string;
  fieldKey: string;
  value: string | null;
  confidence: number;
  confidenceTier: FieldConfidenceTier;
  bbox: { x: number; y: number; w: number; h: number } | null;
  source: string;
  needsReview: boolean;
  reviewed: boolean;
  createdAt: string;
} {
  return {
    id: row.id,
    fieldKey: row.field_key,
    value: row.field_value,
    confidence: row.confidence,
    confidenceTier: row.confidence_tier,
    bbox: parseBbox(row.bbox_json),
    source: row.source,
    needsReview: row.needs_review,
    reviewed: row.reviewed,
    createdAt: toIsoString(row.created_at),
  };
}

async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface PageExtractionResult {
  documentId: string;
  claimId: string;
  pageNumber: number;
  processingStatus: string;
  ocr: {
    rawText: string | null;
    engine: string | null;
    confidence: number | null;
    wordCount: number | null;
  };
  imageQualityScore: number | null;
  fields: Array<{
    id: string;
    fieldKey: string;
    value: string | null;
    confidence: number;
    confidenceTier: FieldConfidenceTier;
    bbox: { x: number; y: number; w: number; h: number } | null;
    source: string;
    needsReview: boolean;
    reviewed: boolean;
    createdAt: string;
  }>;
}

export interface CorrectFieldResult {
  field: {
    id: string;
    claimId: string;
    documentId: string;
    pageNumber: number;
    fieldKey: string;
    value: string | null;
    source: string;
    needsReview: boolean;
    reviewed: boolean;
    updatedAt: string;
  };
  correction: {
    id: string;
    extractedFieldId: string;
    originalValue: string | null;
    correctedValue: string;
    correctedBy: string;
    correctedAt: string;
    usedForTraining: boolean;
  };
}

export class ExtractionService {
  constructor(private readonly pool: Pool) {}

  async getPageExtraction(params: GetPageExtractionParams): Promise<PageExtractionResult> {
    const contextResult = await this.pool.query<PageContextRow>(
      `SELECT
          d.id AS document_id,
          d.claim_id,
          d.processing_status,
          dp.page_number,
          dp.status AS page_status,
          dp.ocr_engine_used,
          dp.overall_confidence AS page_confidence,
          dp.image_quality_score
        FROM documents d
        JOIN claims c ON c.id = d.claim_id
        LEFT JOIN document_pages dp
          ON dp.document_id = d.id
         AND dp.page_number = $3
       WHERE d.id = $1::uuid
         AND c.tenant_id = $2::uuid
       LIMIT 1`,
      [params.documentId, params.tenantId, params.pageNumber],
    );

    const context = contextResult.rows[0];

    if (!context) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Document not found');
    }

    if (context.page_number === null) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Document page not found');
    }

    const ocrResult = await this.pool.query<OcrRow>(
      `SELECT raw_text, engine, overall_confidence, word_count
         FROM ocr_text
        WHERE document_id = $1::uuid
          AND page_number = $2
        ORDER BY overall_confidence DESC, created_at DESC
        LIMIT 1`,
      [params.documentId, params.pageNumber],
    );

    const extractedFields = await this.pool.query<ExtractedFieldRow>(
      `SELECT
          ef.id,
          ef.field_key,
          ef.field_value,
          ef.confidence,
          ef.confidence_tier,
          ef.bbox_json,
          ef.source,
          ef.needs_review,
          ef.reviewed,
          ef.created_at
        FROM extracted_fields ef
        JOIN claims c ON c.id = ef.claim_id
       WHERE ef.document_id = $1::uuid
         AND ef.page_number = $2
         AND c.tenant_id = $3::uuid
       ORDER BY ef.created_at ASC, ef.id ASC`,
      [params.documentId, params.pageNumber, params.tenantId],
    );

    const ocr = ocrResult.rows[0];

    return {
      documentId: context.document_id,
      claimId: context.claim_id,
      pageNumber: context.page_number,
      processingStatus: context.page_status ?? context.processing_status,
      ocr: {
        rawText: ocr?.raw_text ?? null,
        engine: ocr?.engine ?? context.ocr_engine_used ?? null,
        confidence: ocr?.overall_confidence ?? context.page_confidence ?? null,
        wordCount: ocr?.word_count ?? null,
      },
      imageQualityScore: context.image_quality_score,
      fields: extractedFields.rows.map(mapExtractedField),
    };
  }

  async correctField(params: CorrectFieldParams): Promise<CorrectFieldResult> {
    return withTransaction(this.pool, async (client) => {
      const fieldResult = await client.query<FieldForUpdateRow>(
        `SELECT
            ef.id,
            ef.claim_id,
            ef.document_id,
            ef.page_number,
            ef.field_key,
            ef.field_value,
            ef.confidence,
            ef.confidence_tier,
            ef.bbox_json,
            ef.source,
            ef.needs_review,
            ef.reviewed,
            ef.created_at,
            c.tenant_id
          FROM extracted_fields ef
          JOIN claims c ON c.id = ef.claim_id
         WHERE ef.id = $1::uuid
         FOR UPDATE`,
        [params.fieldId],
      );

      const currentField = fieldResult.rows[0];

      if (!currentField || currentField.tenant_id !== params.tenantId) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'Extracted field not found');
      }

      const correctionResult = await client.query<CorrectionRow>(
        `INSERT INTO corrections (
            extracted_field_id,
            original_value,
            corrected_value,
            corrected_by
          ) VALUES (
            $1::uuid,
            $2,
            $3,
            $4::uuid
          )
          RETURNING
            id,
            extracted_field_id,
            original_value,
            corrected_value,
            corrected_by,
            corrected_at,
            used_for_training`,
        [
          params.fieldId,
          currentField.field_value,
          params.correctedValue,
          params.userId,
        ],
      );

      const updatedField = await client.query<FieldForUpdateRow>(
        `UPDATE extracted_fields
            SET field_value = $2,
                source = 'MANUAL',
                needs_review = false,
                reviewed = true
          WHERE id = $1::uuid
          RETURNING
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
            reviewed,
            created_at,
            $3::uuid AS tenant_id`,
        [params.fieldId, params.correctedValue, params.tenantId],
      );

      const fieldRow = updatedField.rows[0];
      const correctionRow = correctionResult.rows[0];

      if (!fieldRow || !correctionRow) {
        throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Unable to persist field correction');
      }

      await client.query(
        `INSERT INTO audit_trail (
            tenant_id,
            claim_id,
            user_id,
            action,
            detail_json
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            'FIELD_CORRECTED'::audit_action,
            $4::jsonb
          )`,
        [
          params.tenantId,
          fieldRow.claim_id,
          params.userId,
          JSON.stringify({
            requestId: params.requestId,
            extractedFieldId: fieldRow.id,
            fieldKey: fieldRow.field_key,
            originalValue: currentField.field_value,
            correctedValue: params.correctedValue,
          }),
        ],
      );

      return {
        field: {
          id: fieldRow.id,
          claimId: fieldRow.claim_id,
          documentId: fieldRow.document_id,
          pageNumber: fieldRow.page_number,
          fieldKey: fieldRow.field_key,
          value: fieldRow.field_value,
          source: fieldRow.source,
          needsReview: fieldRow.needs_review,
          reviewed: fieldRow.reviewed,
          updatedAt: new Date().toISOString(),
        },
        correction: {
          id: correctionRow.id,
          extractedFieldId: correctionRow.extracted_field_id,
          originalValue: correctionRow.original_value,
          correctedValue: correctionRow.corrected_value,
          correctedBy: correctionRow.corrected_by,
          correctedAt: toIsoString(correctionRow.corrected_at),
          usedForTraining: correctionRow.used_for_training,
        },
      };
    });
  }
}

export function createExtractionService(pool: Pool): ExtractionService {
  return new ExtractionService(pool);
}