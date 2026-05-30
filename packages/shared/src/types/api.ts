// ============================================================================
// API TYPES — Section 10 (API Contracts)
// ============================================================================

/** Standard success response envelope */
export interface ApiResponse<T> {
  data: T;
  meta?: {
    cursor?: string | null;
    hasMore?: boolean;
    total?: number;
    requestId: string;
  };
}

/** Standard error response envelope */
export interface ApiErrorResponse {
  errors: ApiErrorDetail[];
  meta: {
    requestId: string;
  };
}

export interface ApiErrorDetail {
  code: ErrorCode;
  message: string;
  field?: string;
  detail?: Record<string, unknown>;
}

/** Cursor-based pagination request */
export interface CursorPagination {
  cursor?: string;
  limit: number;        // 1–100, default 25
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/** Domain Error Codes — Section 10 Error Taxonomy */
export enum ErrorCode {
  // 400
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_DOCUMENT_TYPE = 'INVALID_DOCUMENT_TYPE',

  // 401
  UNAUTHORIZED = 'UNAUTHORIZED',
  MFA_REQUIRED = 'MFA_REQUIRED',

  // 403
  FORBIDDEN = 'FORBIDDEN',

  // 404
  NOT_FOUND = 'NOT_FOUND',

  // 409
  CONCURRENCY_CONFLICT = 'CONCURRENCY_CONFLICT',
  DUPLICATE_CLAIM = 'DUPLICATE_CLAIM',

  // 413
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',

  // 422
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  RULE_HARD_STOP = 'RULE_HARD_STOP',

  // 429
  RATE_LIMITED = 'RATE_LIMITED',

  // 500
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  // 503
  EXTERNAL_DEPENDENCY_DEGRADED = 'EXTERNAL_DEPENDENCY_DEGRADED',
}

/** Map error codes to HTTP status codes */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.INVALID_DOCUMENT_TYPE]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.MFA_REQUIRED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONCURRENCY_CONFLICT]: 409,
  [ErrorCode.DUPLICATE_CLAIM]: 409,
  [ErrorCode.FILE_TOO_LARGE]: 413,
  [ErrorCode.INVALID_STATE_TRANSITION]: 422,
  [ErrorCode.RULE_HARD_STOP]: 422,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED]: 503,
};

/** Domain error class for typed error throwing */
export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly field?: string;
  public readonly detail?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus?: number,
    field?: string,
    detail?: Record<string, unknown>
  );

  constructor(
    code: ErrorCode,
    message: string,
    options?: { httpStatus?: number; field?: string; detail?: Record<string, unknown> }
  );

  constructor(
    code: ErrorCode,
    message: string,
    httpStatusOrOptions?: number | { httpStatus?: number; field?: string; detail?: Record<string, unknown> },
    fieldArg?: string,
    detailArg?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;

    if (typeof httpStatusOrOptions === 'number') {
      this.httpStatus = httpStatusOrOptions;
      this.field = fieldArg;
      this.detail = detailArg;
      return;
    }

    this.httpStatus = httpStatusOrOptions?.httpStatus ?? ERROR_HTTP_STATUS[code];
    this.field = httpStatusOrOptions?.field;
    this.detail = httpStatusOrOptions?.detail;
  }
}

