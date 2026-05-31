import { describe, expect, it } from 'vitest';
import { PayerStatus } from '@claimflow/shared';
import { mapPayerRow, type PayerRow } from '../services/payer-service.js';

const baseRow: PayerRow = {
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'sha',
  name: 'Social Health Authority',
  short_name: 'SHA',
  status: 'ACTIVE',
  rulepack_version: '1.0.0',
  country_code: 'KE',
  sort_order: 1,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
};

describe('mapPayerRow', () => {
  it('maps a db row to a Payer domain object with camelCase fields', () => {
    const payer = mapPayerRow(baseRow);

    expect(payer).toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'sha',
      name: 'Social Health Authority',
      shortName: 'SHA',
      status: PayerStatus.ACTIVE,
      rulepackVersion: '1.0.0',
      countryCode: 'KE',
      sortOrder: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('preserves null short_name and rulepack_version for COMING_SOON payers', () => {
    const payer = mapPayerRow({
      ...baseRow,
      slug: 'aar',
      short_name: null,
      status: 'COMING_SOON',
      rulepack_version: null,
    });

    expect(payer.shortName).toBeNull();
    expect(payer.rulepackVersion).toBeNull();
    expect(payer.status).toBe(PayerStatus.COMING_SOON);
  });

  it('normalizes timestamps provided as strings to ISO 8601', () => {
    const payer = mapPayerRow({
      ...baseRow,
      created_at: '2026-03-15T09:30:00Z',
      updated_at: '2026-03-15T09:30:00Z',
    });

    expect(payer.createdAt).toBe('2026-03-15T09:30:00.000Z');
  });

  it('falls back to INACTIVE for an unrecognized status value', () => {
    const payer = mapPayerRow({ ...baseRow, status: 'NONSENSE' });

    expect(payer.status).toBe(PayerStatus.INACTIVE);
  });
});
