import type { SchemaProblem, SchemaApiErrorDetail } from './generated/types.js';

/**
 * A single field-level error detail, as carried in both the problem+json body
 * (`errors[]`) and the `{ errors, meta }` envelope.
 */
export type ApiErrorDetail = SchemaApiErrorDetail;

/**
 * Typed error thrown for any non-2xx response. Parses **both** shapes the API
 * returns — RFC 7807 `application/problem+json` (machine credentials) and the
 * `{ errors, meta }` envelope (human sessions) — into one consistent surface.
 */
export class ClaimFlowError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** Machine-readable error code (e.g. `VALIDATION_ERROR`), when present. */
  readonly code: string | undefined;
  /** RFC 7807 title, when present. */
  readonly title: string | undefined;
  /** RFC 7807 detail, when present. */
  readonly detail: string | undefined;
  /** Field-level error details (from `errors[]` of either shape). */
  readonly errors: ApiErrorDetail[];
  /** Request id echoed in `meta.requestId`, for support/correlation. */
  readonly requestId: string | undefined;
  /** The raw parsed body, for callers that need more than the typed fields. */
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const problem = (body ?? {}) as Partial<SchemaProblem> & {
      errors?: ApiErrorDetail[];
      meta?: { requestId?: string };
    };
    const errors = Array.isArray(problem.errors) ? problem.errors : [];
    const message =
      problem.detail ??
      problem.title ??
      errors[0]?.message ??
      `ClaimFlow request failed with status ${status}`;

    super(message);
    this.name = 'ClaimFlowError';
    this.status = status;
    this.code = problem.code ?? errors[0]?.code;
    this.title = problem.title;
    this.detail = problem.detail;
    this.errors = errors;
    this.requestId = problem.meta?.requestId;
    this.body = body;
  }
}
