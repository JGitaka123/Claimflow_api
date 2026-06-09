import { describe, expect, it, vi } from 'vitest';
import { ClaimFlowClient } from '../client.js';
import { ClaimFlowError } from '../errors.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch stub that records calls and returns queued JSON responses. */
function stubFetch(responses: Array<{ status?: number; body: unknown; contentType?: string }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const SCORE = {
  claimId: 'c1',
  auditId: 'a1',
  payer: { slug: 'sha', name: 'SHA' },
  decision: 'PASS',
  riskScore: 10,
  riskLevel: 'LOW',
  recommendedAction: 'READY_FOR_SUBMISSION',
  flags: [],
  counts: { failed: 0, warning: 0, incomplete: 0, passed: 5 },
};

describe('ClaimFlowClient', () => {
  it('requires credentials', () => {
    expect(() => new ClaimFlowClient({ baseUrl: 'https://x' })).toThrow(/apiKey.*oauth/i);
  });

  it('scoreClaim sends the API key + Idempotency-Key and unwraps the envelope', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 201, body: { data: SCORE } }]);
    const client = new ClaimFlowClient({ baseUrl: 'https://x/', apiKey: 'cf_test', fetch: fetchImpl });

    const result = await client.scoreClaim({ resourceType: 'Claim' } as never, 'idem-1');

    expect(result.riskLevel).toBe('LOW');
    expect(calls[0]?.url).toBe('https://x/v1/claims/score');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('cf_test');
    expect(headers['idempotency-key']).toBe('idem-1');
  });

  it('submitClaimBatch returns the 202 acceptance body', async () => {
    const accepted = { batchId: 'b1', status: 'QUEUED', totalClaims: 2, createdAt: '2026-01-01T00:00:00Z' };
    const { fetchImpl } = stubFetch([{ status: 202, body: { data: accepted } }]);
    const client = new ClaimFlowClient({ baseUrl: 'https://x', apiKey: 'cf_test', fetch: fetchImpl });

    const res = await client.submitClaimBatch({ claims: [] } as never);
    expect(res.batchId).toBe('b1');
  });

  it('getClaimBatch encodes the id into the path', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { data: { batchId: 'b 1', status: 'COMPLETED' } } }]);
    const client = new ClaimFlowClient({ baseUrl: 'https://x', apiKey: 'cf_test', fetch: fetchImpl });

    await client.getClaimBatch('b 1');
    expect(calls[0]?.url).toBe('https://x/v1/claims/batch/b%201');
  });

  it('exchanges + caches an OAuth token, then reuses it', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { access_token: 'tok-abc', token_type: 'Bearer', expires_in: 3600, scope: 'claim:create' } },
      { status: 201, body: { data: SCORE } },
      { status: 201, body: { data: SCORE } },
    ]);
    const client = new ClaimFlowClient({
      baseUrl: 'https://x',
      oauth: { clientId: 'id', clientSecret: 'secret', scope: 'claim:create' },
      fetch: fetchImpl,
    });

    await client.scoreClaim({ resourceType: 'Claim' } as never);
    await client.scoreClaim({ resourceType: 'Claim' } as never);

    // 1 token exchange + 2 scores = 3 calls (token fetched once, then cached).
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://x/v1/oauth/token');
    const scoreHeaders = calls[1]?.init.headers as Record<string, string>;
    expect(scoreHeaders['authorization']).toBe('Bearer tok-abc');
  });

  it('throws a typed ClaimFlowError parsed from problem+json', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_ERROR',
      detail: 'claims must be non-empty',
      errors: [{ code: 'VALIDATION_ERROR', message: 'claims must be non-empty', field: 'claims' }],
      meta: { requestId: 'req-99' },
    };
    const { fetchImpl } = stubFetch([
      { status: 400, body: problem, contentType: 'application/problem+json' },
    ]);
    const client = new ClaimFlowClient({ baseUrl: 'https://x', apiKey: 'cf_test', fetch: fetchImpl });

    await expect(client.scoreClaim({ resourceType: 'Claim' } as never)).rejects.toMatchObject({
      name: 'ClaimFlowError',
      status: 400,
      code: 'VALIDATION_ERROR',
      requestId: 'req-99',
    });
    const err = await client.scoreClaim({ resourceType: 'Claim' } as never).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimFlowError);
    expect(err.errors[0].field).toBe('claims');
  });

  it('parses the human { errors, meta } envelope shape too', async () => {
    const envelope = { errors: [{ code: 'NOT_FOUND', message: 'Batch not found' }], meta: { requestId: 'r2' } };
    const { fetchImpl } = stubFetch([{ status: 404, body: envelope }]);
    const client = new ClaimFlowClient({ baseUrl: 'https://x', apiKey: 'cf_test', fetch: fetchImpl });

    const err = await client.getClaimBatch('missing').catch((e) => e as ClaimFlowError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Batch not found');
  });
});
