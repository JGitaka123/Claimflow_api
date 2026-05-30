import { describe, expect, it } from 'vitest';
import { sanitizeLogObject } from '../logging/sanitizer.js';

describe('sanitizeLogObject', () => {
  it('redacts PHI keys in snake_case and camelCase', () => {
    const sanitized = sanitizeLogObject({
      patient_name: 'Jane Doe',
      patientName: 'Jane Doe',
      patient_national_id: '12345678',
      patientNationalId: '12345678',
      national_id: '99999999',
      nationalId: '99999999',
    });

    expect(sanitized).toMatchObject({
      patient_name: '[REDACTED]',
      patientName: '[REDACTED]',
      patient_national_id: '[REDACTED]',
      patientNationalId: '[REDACTED]',
      national_id: '[REDACTED]',
      nationalId: '[REDACTED]',
    });
  });

  it('redacts nested structures and keeps non-sensitive fields', () => {
    const sanitized = sanitizeLogObject({
      requestId: 'req-1',
      detail: {
        patient_name: 'Secret Name',
        metadata: {
          nationalId: '1234',
          claimId: 'claim-1',
        },
      },
      values: [{ patientName: 'Hidden' }, { claimId: 'claim-2' }],
    });

    expect(sanitized).toMatchObject({
      requestId: 'req-1',
      detail: {
        patient_name: '[REDACTED]',
        metadata: {
          nationalId: '[REDACTED]',
          claimId: 'claim-1',
        },
      },
      values: [{ patientName: '[REDACTED]' }, { claimId: 'claim-2' }],
    });
  });
});
