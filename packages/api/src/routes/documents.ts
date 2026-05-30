import fp from 'fastify-plugin';
import {
  DomainError,
  ErrorCode,
  UploadDocumentSchema,
} from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { fileTypeFromBuffer } from 'file-type';
import { getPool } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { createDocumentService } from '../services/document-service.js';
import { createLocalFsDocumentStore } from '../storage/local-fs-store.js';

const ClaimIdParamsSchema = z.object({
  claimId: z.string().uuid(),
});

const DocumentIdParamsSchema = z.object({
  docId: z.string().uuid(),
});

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
]);

function countPdfPages(buffer: Buffer): number {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page\b/g);

  if (!matches || matches.length === 0) {
    return 1;
  }

  return matches.length;
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'document.bin';
}

async function consumeFilePart(part: MultipartFile, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of part.file) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;

    if (total > maxBytes) {
      throw new DomainError(ErrorCode.FILE_TOO_LARGE, 'Uploaded file exceeds configured size limit');
    }

    chunks.push(buffer);
  }

  if (part.file.truncated) {
    throw new DomainError(ErrorCode.FILE_TOO_LARGE, 'Uploaded file exceeds configured size limit');
  }

  return Buffer.concat(chunks);
}

const documentsRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getPool(fastify.config);
  const documentStore = createLocalFsDocumentStore(fastify.config.STORAGE_PATH);
  const documentService = createDocumentService(pool, fastify.log, documentStore);

  fastify.post('/v1/claims/:claimId/documents', {
    preHandler: requirePermission('document:upload'),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);

    let fileBuffer: Buffer | null = null;
    let originalFilename = 'document.bin';
    let rawDocType: string | undefined;

    for await (const part of request.parts()) {
      if (part.type === 'field' && part.fieldname === 'docType') {
        rawDocType = String(part.value);
        continue;
      }

      if (part.type === 'file') {
        if (part.fieldname !== 'file') {
          for await (const _ of part.file) {
            // consume ignored file stream
          }
          continue;
        }

        fileBuffer = await consumeFilePart(part, fastify.config.MAX_UPLOAD_SIZE_MB * 1024 * 1024);
        originalFilename = part.filename ?? 'document.bin';
      }
    }

    if (!fileBuffer) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Missing file field', {
        field: 'file',
      });
    }

    if (!rawDocType) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Missing docType field', {
        field: 'docType',
      });
    }

    const { docType } = UploadDocumentSchema.parse({ docType: rawDocType });

    const detectedType = await fileTypeFromBuffer(fileBuffer);
    const detectedMimeType = detectedType?.mime ?? null;

    if (!detectedMimeType || !SUPPORTED_MIME_TYPES.has(detectedMimeType)) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Unsupported file type', {
        field: 'file',
      });
    }

    const pageCount = detectedMimeType === 'application/pdf' ? countPdfPages(fileBuffer) : 1;

    if (pageCount > fastify.config.MAX_PAGES_PER_DOCUMENT) {
      throw new DomainError(ErrorCode.VALIDATION_ERROR, 'Document page limit exceeded', {
        field: 'file',
        detail: {
          maxPages: fastify.config.MAX_PAGES_PER_DOCUMENT,
          pageCount,
        },
      });
    }

    const uploadResult = await documentService.uploadDocument({
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      claimId,
      docType,
      mimeType: detectedMimeType,
      originalFilename: sanitizeFilename(originalFilename),
      fileBuffer,
      pageCount,
      requestId: request.id,
    });

    reply.code(201).send({
      data: uploadResult,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/claims/:claimId/documents', async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { claimId } = ClaimIdParamsSchema.parse(request.params);

    const documents = await documentService.listClaimDocuments({
      tenantId: request.tenant.tenantId,
      claimId,
    });

    reply.send({
      data: documents,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.get('/v1/documents/:docId/download', async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { docId } = DocumentIdParamsSchema.parse(request.params);

    const download = await documentService.downloadDocument({
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      docId,
      requestId: request.id,
    });

    reply.header('content-type', download.mimeType);
    reply.header('content-disposition', `attachment; filename="${sanitizeFilename(download.originalFilename)}"`);

    return reply.send(download.stream);
  });
};

export default fp(documentsRoutes, {
  name: 'documents-routes',
});
