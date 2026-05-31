import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe-style signature: `t=<unixSeconds>,v1=<hexHmacSha256>` where the signed
// payload is `"<t>.<rawBody>"`. Receivers recompute and compare in constant time,
// rejecting stale timestamps.

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function computeWebhookSignature(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
}

export function buildWebhookSignatureHeader(secret: string, rawBody: string, timestampSeconds?: number): string {
  const ts = timestampSeconds ?? Math.floor(Date.now() / 1000);
  return `t=${ts},v1=${computeWebhookSignature(secret, ts, rawBody)}`;
}

function parseHeader(header: string): { timestamp: number; signature: string } | null {
  const parts = header.split(',').map((part) => part.trim());
  let timestamp: number | null = null;
  let signature: string | null = null;

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't' && value) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        timestamp = parsed;
      }
    } else if (key === 'v1' && value) {
      signature = value;
    }
  }

  if (timestamp === null || signature === null) {
    return null;
  }

  return { timestamp, signature };
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}

export function verifyWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  const parsed = parseHeader(header);
  if (!parsed) {
    return false;
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return false;
  }

  const expected = computeWebhookSignature(secret, parsed.timestamp, rawBody);
  return constantTimeEquals(expected, parsed.signature);
}

/** Exponential backoff (seconds) for delivery attempt N (1-based): 60, 120, 240, … capped at 1h. */
export function backoffSeconds(attempt: number): number {
  const base = 60 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 3600);
}
