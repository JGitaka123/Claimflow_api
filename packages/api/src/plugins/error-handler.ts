import fp from 'fastify-plugin';
import { DomainError, ErrorCode } from '@claimflow/shared';
import { ZodError } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorDetail, ApiErrorResponse } from '@claimflow/shared';

// Public endpoints that return RFC 7807 application/problem+json errors instead of
// the internal { data, meta, errors } envelope. Scoped narrowly so the existing
// web frontend and internal routes are unaffected.
const PROBLEM_JSON_PREFIXES = ['/v1/claims/score'];

function requestPath(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? request.url ?? '/';
  return rawUrl.split('?')[0] ?? rawUrl;
}

function wantsProblemJson(request: FastifyRequest): boolean {
  const path = requestPath(request);
  return PROBLEM_JSON_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const PROBLEM_TITLES: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.VALIDATION_ERROR]: 'Validation failed',
  [ErrorCode.UNAUTHORIZED]: 'Authentication required',
  [ErrorCode.FORBIDDEN]: 'Forbidden',
  [ErrorCode.NOT_FOUND]: 'Resource not found',
  [ErrorCode.DUPLICATE_CLAIM]: 'Duplicate claim',
  [ErrorCode.INVALID_STATE_TRANSITION]: 'Invalid state transition',
  [ErrorCode.RULE_HARD_STOP]: 'Adjudication hard stop',
  [ErrorCode.RATE_LIMITED]: 'Rate limit exceeded',
  [ErrorCode.FILE_TOO_LARGE]: 'Payload too large',
  [ErrorCode.INTERNAL_ERROR]: 'Internal server error',
  [ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED]: 'Dependency degraded',
};

function toEnvelope(requestId: string, errors: ApiErrorDetail[]): ApiErrorResponse {
  return { errors, meta: { requestId } };
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  details: ApiErrorDetail[],
): void {
  const primary = details[0];
  const code = primary?.code ?? ErrorCode.INTERNAL_ERROR;

  reply
    .status(status)
    .header('content-type', 'application/problem+json')
    .send({
      type: `https://claimflow.dev/problems/${code.toLowerCase()}`,
      title: PROBLEM_TITLES[code] ?? code,
      status,
      detail: primary?.message ?? 'Request failed',
      code,
      instance: requestPath(request),
      ...(details.length > 0
        ? {
            errors: details.map((detail) => ({
              code: detail.code,
              message: detail.message,
              field: detail.field,
            })),
          }
        : {}),
    });
}

function send(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  details: ApiErrorDetail[],
): void {
  if (wantsProblemJson(request)) {
    sendProblem(request, reply, status, details);
    return;
  }

  reply.status(status).send(toEnvelope(request.id, details));
}

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      const details: ApiErrorDetail[] = error.issues.map((issue) => ({
        code: ErrorCode.VALIDATION_ERROR,
        message: issue.message,
        field: issue.path.join('.') || undefined,
        detail: { code: issue.code },
      }));

      send(request, reply, 400, details);
      return;
    }

    if (error instanceof DomainError) {
      send(request, reply, error.httpStatus, [
        { code: error.code, message: error.message, field: error.field, detail: error.detail },
      ]);
      return;
    }

    if ((error as { statusCode?: number }).statusCode === 413) {
      send(request, reply, 413, [
        { code: ErrorCode.FILE_TOO_LARGE, message: 'Uploaded file exceeds configured size limit' },
      ]);
      return;
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      send(request, reply, 429, [{ code: ErrorCode.RATE_LIMITED, message: 'Rate limit exceeded' }]);
      return;
    }

    request.log.error({ err: error }, 'Unhandled API error');

    send(request, reply, 500, [
      { code: ErrorCode.INTERNAL_ERROR, message: 'Internal server error' },
    ]);
  });
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler-plugin',
});
