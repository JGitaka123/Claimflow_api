import type { components } from './generated/types.js';
import { ClaimFlowError } from './errors.js';

type Schemas = components['schemas'];

export type ScoreClaimRequest = Schemas['ScoreClaimRequest'];
export type ClaimScoreResult = Schemas['ClaimScoreResult'];
export type BatchSubmitRequest = Schemas['BatchSubmitRequest'];
export type ClaimBatchAccepted = Schemas['ClaimBatchAccepted'];
export type ClaimBatchStatus = Schemas['ClaimBatchStatus'];
export type CreateClaimRequest = Schemas['CreateClaimRequest'];
export type ClaimSummary = Schemas['ClaimSummary'];

/** OAuth2 client-credentials configuration. */
export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  /** Optional space-delimited down-scoping (a subset of the client's scopes). */
  scope?: string;
}

export interface ClaimFlowClientOptions {
  /** API base URL, e.g. `https://claimflow.hospital.example` (no trailing slash needed). */
  baseUrl: string;
  /** Tenant-scoped machine key (`cf_…`). Mutually exclusive with `oauth`. */
  apiKey?: string;
  /** OAuth2 client-credentials. The bearer token is fetched + cached until expiry. */
  oauth?: OAuthCredentials;
  /** Per-request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Injectable fetch (defaults to global fetch); handy for tests. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  /** Replay-safe submission key for write endpoints. */
  idempotencyKey?: string;
  /** Skip auth header injection (used for the token exchange itself). */
  noAuth?: boolean;
  query?: Record<string, string | number | undefined>;
}

interface CachedToken {
  accessToken: string;
  /** epoch ms after which the token must be refreshed. */
  expiresAtMs: number;
}

/**
 * Thin, typed ClaimFlow API client. Everything below the convenience methods is
 * generated from `docs/openapi.yaml`, so adding a spec field flows through to the
 * types automatically. Handles API-key + OAuth2 client-credentials auth,
 * Idempotency-Key, and problem+json/envelope error parsing.
 */
export class ClaimFlowClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly oauth: OAuthCredentials | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: CachedToken | undefined;

  constructor(options: ClaimFlowClientOptions) {
    if (!options.apiKey && !options.oauth) {
      throw new Error('ClaimFlowClient requires either `apiKey` or `oauth` credentials.');
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.oauth = options.oauth;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('No fetch implementation available; pass `fetch` in options.');
    }
  }

  // ---- convenience methods (typed off the generated spec) -------------------

  /** Score a FHIR R4 Claim. Returns the public-safe score (no rule internals). */
  async scoreClaim(body: ScoreClaimRequest, idempotencyKey?: string): Promise<ClaimScoreResult> {
    const res = await this.request<{ data: ClaimScoreResult }>({
      method: 'POST',
      path: '/v1/claims/score',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return res.data;
  }

  /** Submit a batch of claims for async scoring. Returns the 202 acceptance. */
  async submitClaimBatch(
    body: BatchSubmitRequest,
    idempotencyKey?: string,
  ): Promise<ClaimBatchAccepted> {
    const res = await this.request<{ data: ClaimBatchAccepted }>({
      method: 'POST',
      path: '/v1/claims/batch',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return res.data;
  }

  /** Poll batch status + per-claim closed scores. */
  async getClaimBatch(batchId: string): Promise<ClaimBatchStatus> {
    const res = await this.request<{ data: ClaimBatchStatus }>({
      method: 'GET',
      path: `/v1/claims/batch/${encodeURIComponent(batchId)}`,
    });
    return res.data;
  }

  /** Create a claim. */
  async createClaim(body: CreateClaimRequest, idempotencyKey?: string): Promise<ClaimSummary> {
    const res = await this.request<{ data: ClaimSummary }>({
      method: 'POST',
      path: '/v1/claims',
      body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return res.data;
  }

  /** List claims (cursor-paginated). */
  async listClaims(query?: { cursor?: string; limit?: number }): Promise<ClaimSummary[]> {
    const res = await this.request<{ data: ClaimSummary[] }>({
      method: 'GET',
      path: '/v1/claims',
      ...(query
        ? { query: { ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.limit ? { limit: query.limit } : {}) } }
        : {}),
    });
    return res.data;
  }

  // ---- core request plumbing ------------------------------------------------

  /** Issue a raw, authenticated request and parse the envelope/problem body. */
  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + opts.path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    if (!opts.noAuth) await this.applyAuth(headers);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: opts.method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const parsed = await this.parseBody(response);
    if (!response.ok) {
      throw new ClaimFlowError(response.status, parsed);
    }
    return parsed as T;
  }

  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return undefined;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  // ---- auth -----------------------------------------------------------------

  private async applyAuth(headers: Record<string, string>): Promise<void> {
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
      return;
    }
    if (this.oauth) {
      headers['authorization'] = `Bearer ${await this.getAccessToken()}`;
    }
  }

  /** Fetch (and cache, with a 30s safety margin) an OAuth client-credentials token. */
  private async getAccessToken(): Promise<string> {
    if (!this.oauth) throw new Error('No OAuth credentials configured.');
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs > now) {
      return this.cachedToken.accessToken;
    }
    const body: Record<string, string> = {
      grant_type: 'client_credentials',
      client_id: this.oauth.clientId,
      client_secret: this.oauth.clientSecret,
    };
    if (this.oauth.scope) body['scope'] = this.oauth.scope;

    const token = await this.request<{ access_token: string; expires_in: number }>({
      method: 'POST',
      path: '/v1/oauth/token',
      body,
      noAuth: true,
    });
    this.cachedToken = {
      accessToken: token.access_token,
      expiresAtMs: now + Math.max(0, token.expires_in - 30) * 1000,
    };
    return token.access_token;
  }
}
