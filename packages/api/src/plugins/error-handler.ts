import fp from 'fastify-plugin';
import { DomainError, ErrorCode } from '@claimflow/shared';
import { ZodError } from 'zod';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorDetail, ApiErrorResponse } from '@claimflow/shared';

// External integrators (machine credentials) must get ONE consistent error shape
// on every endpoint they call. We therefore return RFC 7807 application/problem+json
// whenever EITHER:
//   - the caller is a machine credential (API key or OAuth client — request.apiKey
//     is set for both), regardless of which endpoint they hit; OR
//   - the request is to a public machine endpoint that has no human-session caller
//     (the scoring + oauth-token endpoints, which authenticate inside the handler).
// Human JWT sessions (the internal web app) keep the { data, meta, errors } envelope.
// The Problem body is a strict SUPERSET of the envelope (it also carries errors[]
// and meta.requestId), so existing envelope readers keep working.
const PUBLIC_MACHINE_PREFIXES = ['/v1/claims/score', '/v1/oauth/token'];

function requestPath(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? request.url ?? '/';
  return rawUrl.split('?')[0] ?? rawUrl;
}

function wantsProblemJson(request: FastifyRequest): boolean {
  if (request.apiKey) {
    return true;
  }
  const path = requestPath(request);
  return PUBLIC_MACHINE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
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
      // Superset of the envelope: keep meta.requestId + errors[] so existing
      // envelope readers (web app, tests) work against problem+json unchanged.
      meta: { requestId: request.id },
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

    // Item 7: detect Postgres row-level-security policy violations and bump the
    // anomaly counter so alerts can fire on any non-zero rate (RLS denials are
    // always alert-worthy — they indicate either a tenant-isolation bug or an
    // attack probe). Pattern covers both write-side ("new row violates ... policy")
    // and the role-level "permission denied" wording.
    const message = String((error as { message?: unknown }).message ?? '');
    if (/row-level security|new row violates row-level security|permission denied for (table|relation)/i.test(message)) {
      fastify.metricsRegistry.recordRlsDenial();
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
