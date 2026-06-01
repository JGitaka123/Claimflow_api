import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  ClaimStatus,
  DOC_PROCESSING_ROUTES,
  DocProcessingStatus,
  DomainError,
  ErrorCode,
  type DocProcessingRoute,
  type DocumentType,
} from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { PoolClient, QueryResultRow } from 'pg';
import type { TenantDb } from '../db/client.js';
import type { Readable } from 'node:stream';
import type { DocumentStore } from '../storage/document-store.js';

interface UploadDocumentParams {
  tenantId: string;
  userId: string;
  claimId: string;
  docType: DocumentType;
  mimeType: string;
  originalFilename: string;
  fileBuffer: Buffer;
  pageCount: number;
  requestId: string;
}

interface ListClaimDocumentsParams {
  tenantId: string;
  claimId: string;
}

interface DownloadDocumentParams {
  tenantId: string;
  userId: string;
  docId: string;
  requestId: string;
}

export interface UploadedDocumentPage {
  id: string;
  pageNumber: number;
  status: DocProcessingStatus;
}

export interface UploadedDocumentResult {
  document: {
    id: string;
    claimId: string;
    docType: DocumentType;
    processingRoute: DocProcessingRoute;
    processingStatus: DocProcessingStatus;
    mimeType: string;
    originalFilename: string;
    pageCount: number;
    fileSizeBytes: number;
    sha256: string;
    storagePath: string;
    uploadedAt: string;
  };
  pages: UploadedDocumentPage[];
}

export interface ClaimDocumentListItem {
  id: string;
  claimId: string;
  docType: DocumentType;
  processingRoute: DocProcessingRoute;
  processingStatus: DocProcessingStatus;
  mimeType: string;
  originalFilename: string;
  pageCount: number;
  fileSizeBytes: number;
  sha256: string;
  uploadedAt: string;
}

export interface DownloadDocumentResult {
  docId: string;
  claimId: string;
  mimeType: string;
  originalFilename: string;
  stream: Readable;
}

interface ClaimRow extends QueryResultRow {
  id: string;
  status: ClaimStatus;
}

interface DocumentRow extends QueryResultRow {
  id: string;
  claim_id: string;
  doc_type: DocumentType;
  processing_route: DocProcessingRoute;
  processing_status: DocProcessingStatus;
  mime_type: string;
  original_filename: string;
  page_count: number;
  file_size_bytes: number;
  sha256: string;
  storage_path: string;
  uploaded_at: Date | string;
}

interface DocumentPageRow extends QueryResultRow {
  id: string;
  page_number: number;
  status: DocProcessingStatus;
}

function toIsoString(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function getExtensionForMimeType(mimeType: string): string {
  if (mimeType === 'application/pdf') {
    return 'pdf';
  }

  if (mimeType === 'image/jpeg') {
    return 'jpg';
  }

  if (mimeType === 'image/png') {
    return 'png';
  }

  if (mimeType === 'image/tiff') {
    return 'tiff';
  }

  throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Unsupported MIME type', {
    field: 'file',
    detail: { mimeType },
  });
}

async function withTransaction<T>(db: TenantDb, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  return db.transaction(callback);
}

function mapDocument(row: DocumentRow): ClaimDocumentListItem {
  return {
    id: row.id,
    claimId: row.claim_id,
    docType: row.doc_type,
    processingRoute: row.processing_route,
    processingStatus: row.processing_status,
    mimeType: row.mime_type,
    originalFilename: row.original_filename,
    pageCount: row.page_count,
    fileSizeBytes: row.file_size_bytes,
    sha256: row.sha256,
    uploadedAt: toIsoString(row.uploaded_at),
  };
}

export class DocumentService {
  constructor(
    private readonly pool: TenantDb,
    private readonly logger: FastifyBaseLogger,
    private readonly store: DocumentStore,
  ) {}

  async uploadDocument(params: UploadDocumentParams): Promise<UploadedDocumentResult> {
    this.logger.debug(
      {
        tenantId: params.tenantId,
        claimId: params.claimId,
        docType: params.docType,
        pageCount: params.pageCount,
      },
      'upload document request',
    );

    const processingRoute = DOC_PROCESSING_ROUTES[params.docType];

    if (!processingRoute) {
      throw new DomainError(ErrorCode.INVALID_DOCUMENT_TYPE, 'Unsupported document type', {
        field: 'docType',
      });
    }

    const documentId = randomUUID();
    const extension = getExtensionForMimeType(params.mimeType);
    const checksum = createHash('sha256').update(params.fileBuffer).digest('hex');

    let storagePath = '';

    try {
      return await withTransaction(this.pool, async (client) => {
        const claimResult = await client.query<ClaimRow>(
          `SELECT id, status
             FROM claims
            WHERE id = $1::uuid
              AND tenant_id = $2::uuid
            FOR UPDATE`,
          [params.claimId, params.tenantId],
        );

        const claim = claimResult.rows[0];

        if (!claim) {
          throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
        }

        const stored = await this.store.put({
          tenantId: params.tenantId,
          claimId: params.claimId,
          documentId,
          extension,
          data: params.fileBuffer,
        });

        storagePath = stored.storagePath;

        const insertedDocument = await client.query<DocumentRow>(
          `INSERT INTO documents (
              id,
              claim_id,
              tenant_id,
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
              $3::uuid,
              $4::doc_type,
              $5::doc_processing_route,
              $6,
              $7,
              $8,
              $9,
              $10,
              $11,
              'PENDING'::doc_processing_status,
              $12::uuid
            )
            RETURNING *`,
          [
            documentId,
            params.claimId,
            params.tenantId,
            params.docType,
            processingRoute,
            params.mimeType,
            params.originalFilename,
            params.pageCount,
            params.fileBuffer.length,
            storagePath,
            checksum,
            params.userId,
          ],
        );

        const documentRow = insertedDocument.rows[0];

        if (!documentRow) {
          throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to insert document');
        }

        const pageRows: UploadedDocumentPage[] = [];

        for (let pageNumber = 1; pageNumber <= params.pageCount; pageNumber += 1) {
          const pageInsert = await client.query<DocumentPageRow>(
            `INSERT INTO document_pages (
                document_id,
                page_number,
                status
              ) VALUES (
                $1::uuid,
                $2,
                'PENDING'::doc_processing_status
              )
              RETURNING id, page_number, status`,
            [documentId, pageNumber],
          );

          const pageRow = pageInsert.rows[0];

          if (pageRow) {
            pageRows.push({
              id: pageRow.id,
              pageNumber: pageRow.page_number,
              status: pageRow.status,
            });
          }
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
              'DOCUMENT_UPLOADED'::audit_action,
              $4::jsonb
            )`,
          [
            params.tenantId,
            params.claimId,
            params.userId,
            JSON.stringify({
              requestId: params.requestId,
              documentId,
              docType: params.docType,
              pageCount: params.pageCount,
            }),
          ],
        );

        if (claim.status === ClaimStatus.DRAFT) {
          await client.query(
            `UPDATE claims
                SET status = 'DOCUMENTS_UPLOADED'::claim_status,
                    version = version + 1,
                    updated_at = now()
              WHERE id = $1::uuid`,
            [params.claimId],
          );

          await client.query(
            `INSERT INTO audit_trail (
                tenant_id,
                claim_id,
                user_id,
                action,
                from_state,
                to_state,
                detail_json
              ) VALUES (
                $1::uuid,
                $2::uuid,
                $3::uuid,
                'CLAIM_STATE_CHANGED'::audit_action,
                'DRAFT'::claim_status,
                'DOCUMENTS_UPLOADED'::claim_status,
                $4::jsonb
              )`,
            [
              params.tenantId,
              params.claimId,
              params.userId,
              JSON.stringify({
                source: 'document_upload',
                documentId,
              }),
            ],
          );
        }

        return {
          document: {
            id: documentRow.id,
            claimId: documentRow.claim_id,
            docType: documentRow.doc_type,
            processingRoute: documentRow.processing_route,
            processingStatus: documentRow.processing_status,
            mimeType: documentRow.mime_type,
            originalFilename: documentRow.original_filename,
            pageCount: documentRow.page_count,
            fileSizeBytes: documentRow.file_size_bytes,
            sha256: documentRow.sha256,
            storagePath: documentRow.storage_path,
            uploadedAt: toIsoString(documentRow.uploaded_at),
          },
          pages: pageRows,
        };
      });
    } catch (error) {
      if (storagePath) {
        await this.store.delete(storagePath).catch(() => {
          this.logger.warn({ storagePath }, 'failed to clean up stored file after upload failure');
        });
      }

      throw error;
    }
  }

  async listClaimDocuments(params: ListClaimDocumentsParams): Promise<ClaimDocumentListItem[]> {
    const claimExists = await this.pool.query<{ id: string }>(
      `SELECT id
         FROM claims
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
        LIMIT 1`,
      [params.claimId, params.tenantId],
    );

    if (!claimExists.rows[0]) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
    }

    const documents = await this.pool.query<DocumentRow>(
      `SELECT d.*
         FROM documents d
        WHERE d.claim_id = $1::uuid
        ORDER BY d.uploaded_at DESC`,
      [params.claimId],
    );

    return documents.rows.map(mapDocument);
  }

  async downloadDocument(params: DownloadDocumentParams): Promise<DownloadDocumentResult> {
    const documentResult = await this.pool.query<DocumentRow>(
      `SELECT d.*
         FROM documents d
         JOIN claims c ON c.id = d.claim_id
        WHERE d.id = $1::uuid
          AND c.tenant_id = $2::uuid
        LIMIT 1`,
      [params.docId, params.tenantId],
    );

    const document = documentResult.rows[0];

    if (!document) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Document not found');
    }

    const exists = await this.store.exists(document.storage_path);

    if (!exists) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Document file not found');
    }

    await this.pool.query(
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
          'DOCUMENT_DOWNLOADED'::audit_action,
          $4::jsonb
        )`,
      [
        params.tenantId,
        document.claim_id,
        params.userId,
        JSON.stringify({
          requestId: params.requestId,
          documentId: params.docId,
          filename: basename(document.original_filename),
        }),
      ],
    );

    const stream = await this.store.getStream(document.storage_path);

    return {
      docId: document.id,
      claimId: document.claim_id,
      mimeType: document.mime_type,
      originalFilename: document.original_filename,
      stream,
    };
  }
}

export function createDocumentService(pool: TenantDb, logger: FastifyBaseLogger, store: DocumentStore): DocumentService {
  return new DocumentService(pool, logger, store);
}
