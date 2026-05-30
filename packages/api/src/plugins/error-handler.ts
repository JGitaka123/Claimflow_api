import fp from 'fastify-plugin';
import { DomainError, ErrorCode } from '@claimflow/shared';
import { ZodError } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import type { ApiErrorDetail, ApiErrorResponse } from '@claimflow/shared';

function toEnvelope(requestId: string, errors: ApiErrorDetail[]): ApiErrorResponse {
  return {
    errors,
    meta: {
      requestId,
    },
  };
}

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const details: ApiErrorDetail[] = error.issues.map((issue) => ({
        code: ErrorCode.VALIDATION_ERROR,
        message: issue.message,
        field: issue.path.join('.') || undefined,
        detail: {
          code: issue.code,
        },
      }));

      reply.status(400).send(toEnvelope(request.id, details));
      return;
    }

    if (error instanceof DomainError) {
      const detail: ApiErrorDetail = {
        code: error.code,
        message: error.message,
        field: error.field,
        detail: error.detail,
      };

      reply.status(error.httpStatus).send(toEnvelope(request.id, [detail]));
      return;
    }

    if ((error as { statusCode?: number }).statusCode === 413) {
      const detail: ApiErrorDetail = {
        code: ErrorCode.FILE_TOO_LARGE,
        message: 'Uploaded file exceeds configured size limit',
      };

      reply.status(413).send(toEnvelope(request.id, [detail]));
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      const detail: ApiErrorDetail = {
        code: ErrorCode.RATE_LIMITED,
        message: 'Rate limit exceeded',
      };

      reply.status(429).send(toEnvelope(request.id, [detail]));
      return;
    }

    request.log.error({ err: error }, 'Unhandled API error');

    const detail: ApiErrorDetail = {
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    };

    reply.status(500).send(toEnvelope(request.id, [detail]));
  });
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler-plugin',
});

