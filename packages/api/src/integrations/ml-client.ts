import { DomainError, ErrorCode, type DocProcessingRoute, type DocumentType } from '@claimflow/shared';
import { currentLogContext } from '../logging/context.js';

export interface MlProcessDocumentRequest {
  documentId: string;
  storagePath: string;
  docType: DocumentType;
  processingRoute: DocProcessingRoute;
  pages?: number[];
}

export interface MlPageResult {
  page_number: number;
  status: 'COMPLETED' | 'FAILED';
  quality?: {
    score?: number;
    blur_score?: number;
    skew_degrees?: number;
    dpi_estimated?: number;
  };
  ocr?: {
    raw_text?: string;
    overall_confidence?: number;
    word_count?: number;
    engine?: string;
  };
  classification?: {
    predicted_class?: string;
    confidence?: number;
    alternatives?: Array<{ class: string; confidence: number }>;
  };
  extracted_fields?: Array<Record<string, unknown>>;
  signature?: Record<string, unknown>;
  error?: string;
}

export interface MlProcessDocumentResponse {
  document_id: string;
  doc_type: string;
  processing_route: string;
  status: 'COMPLETED' | 'PARTIAL';
  processed_at: string;
  total_pages: number;
  pages_processed: number;
  pages_failed: number;
  pages: MlPageResult[];
  aggregated_fields: Array<Record<string, unknown>>;
}

interface MlClientOptions {
  baseUrl: string;
  timeoutMs: number;
  retriesOnTimeout?: number;
  fetchImpl?: typeof fetch;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class MlClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retriesOnTimeout: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MlClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs;
    this.retriesOnTimeout = options.retriesOnTimeout ?? 1;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async processDocument(payload: MlProcessDocumentRequest): Promise<MlProcessDocumentResponse> {
    const body = JSON.stringify({
      document_id: payload.documentId,
      storage_path: payload.storagePath,
      doc_type: payload.docType,
      processing_route: payload.processingRoute,
      pages: payload.pages,
    });

    const url = `${this.baseUrl}/ml/process-document`;

    let attempt = 0;

    while (attempt <= this.retriesOnTimeout) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        // Item 7: propagate the caller's request id so ML-service logs can be
        // correlated with API logs without a full OpenTelemetry stack. Pulled
        // from the async-local log context entered by the tenant plugin.
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const reqId = currentLogContext().requestId;
        if (reqId) headers['x-request-id'] = reqId;

        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const responseText = await response.text().catch(() => '');

          throw new DomainError(
            ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED,
            'ML service request failed',
            {
              detail: {
                statusCode: response.status,
                responseBody: responseText,
              },
            },
          );
        }

        const parsed = (await response.json()) as MlProcessDocumentResponse;
        return parsed;
      } catch (error) {
        if (isAbortError(error) && attempt < this.retriesOnTimeout) {
          attempt += 1;
          continue;
        }

        if (isAbortError(error)) {
          throw new DomainError(
            ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED,
            `ML service timed out after ${this.timeoutMs}ms`,
          );
        }

        if (error instanceof DomainError) {
          throw error;
        }

        throw new DomainError(
          ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED,
          'ML service is unavailable',
          {
            detail: {
              reason: error instanceof Error ? error.message : 'unknown_error',
            },
          },
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw new DomainError(ErrorCode.EXTERNAL_DEPENDENCY_DEGRADED, 'ML service request retries exhausted');
  }
}