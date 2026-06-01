import fp from 'fastify-plugin';
import { CorrectFieldSchema, DomainError, ErrorCode } from '@claimflow/shared';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getTenantDb } from '../db/client.js';
import { requirePermission } from '../plugins/auth.js';
import { createExtractionService } from '../services/extraction-service.js';

const ExtractionParamsSchema = z.object({
  docId: z.string().uuid(),
  pageNumber: z.coerce.number().int().min(1),
});

const FieldParamsSchema = z.object({
  fieldId: z.string().uuid(),
});

const extractionRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getTenantDb(fastify.config);
  const extractionService = createExtractionService(pool);

  fastify.get('/v1/documents/:docId/pages/:pageNumber/extraction', async (request, reply) => {
    if (!request.tenant) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { docId, pageNumber } = ExtractionParamsSchema.parse(request.params);

    const extraction = await extractionService.getPageExtraction({
      tenantId: request.tenant.tenantId,
      documentId: docId,
      pageNumber,
    });

    reply.send({
      data: extraction,
      meta: {
        requestId: request.id,
      },
    });
  });

  fastify.post('/v1/extracted-fields/:fieldId/correct', {
    preHandler: requirePermission('field:correct'),
  }, async (request, reply) => {
    if (!request.tenant || !request.user) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Authentication required');
    }

    const { fieldId } = FieldParamsSchema.parse(request.params);
    const body = CorrectFieldSchema.parse(request.body);

    const result = await extractionService.correctField({
      tenantId: request.tenant.tenantId,
      userId: request.user.userId,
      fieldId,
      correctedValue: body.correctedValue,
      requestId: request.id,
    });

    reply.send({
      data: result,
      meta: {
        requestId: request.id,
      },
    });
  });
};

export default fp(extractionRoutes, {
  name: 'extraction-routes',
});
