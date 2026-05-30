const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_KEY_FINGERPRINTS = new Set([
  'patientname',
  'patientnationalid',
  'nationalid',
]);

function keyFingerprint(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_FINGERPRINTS.has(keyFingerprint(key));
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  if (value instanceof Date || value instanceof Error || Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(input)) {
      if (isSensitiveKey(key)) {
        output[key] = REDACTED_VALUE;
        continue;
      }

      output[key] = sanitizeValue(nestedValue, seen);
    }

    seen.delete(value);
    return output;
  }

  return value;
}

export function sanitizeLogObject(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(payload, new WeakSet<object>()) as Record<string, unknown>;
}
