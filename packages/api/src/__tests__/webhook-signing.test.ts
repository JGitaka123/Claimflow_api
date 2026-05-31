import { describe, expect, it } from 'vitest';
import {
  backoffSeconds,
  buildWebhookSignatureHeader,
  computeWebhookSignature,
  verifyWebhookSignature,
} from '../integrations/webhook-signing.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'claim.flagged', data: { claimId: 'c1' } });

describe('webhook signing', () => {
  it('round-trips a signature for an untampered body', () => {
    const ts = 1_900_000_000;
    const header = buildWebhookSignatureHeader(SECRET, BODY, ts);

    expect(header).toContain(`t=${ts}`);
    expect(header).toContain('v1=');
    expect(verifyWebhookSignature(SECRET, header, BODY, { nowSeconds: ts })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = 1_900_000_000;
    const header = buildWebhookSignatureHeader(SECRET, BODY, ts);

    expect(verifyWebhookSignature(SECRET, header, `${BODY} `, { nowSeconds: ts })).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const ts = 1_900_000_000;
    const header = buildWebhookSignatureHeader(SECRET, BODY, ts);

    expect(verifyWebhookSignature('whsec_other', header, BODY, { nowSeconds: ts })).toBe(false);
  });

  it('rejects a stale timestamp outside tolerance', () => {
    const ts = 1_900_000_000;
    const header = buildWebhookSignatureHeader(SECRET, BODY, ts);

    expect(
      verifyWebhookSignature(SECRET, header, BODY, { nowSeconds: ts + 10_000, toleranceSeconds: 300 }),
    ).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(verifyWebhookSignature(SECRET, 'not-a-valid-header', BODY)).toBe(false);
  });

  it('computes a stable HMAC for the same inputs', () => {
    expect(computeWebhookSignature(SECRET, 100, BODY)).toBe(computeWebhookSignature(SECRET, 100, BODY));
  });

  it('uses capped exponential backoff', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(3)).toBe(240);
    expect(backoffSeconds(20)).toBe(3600);
  });
});
