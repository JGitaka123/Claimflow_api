import { describe, expect, it } from 'vitest';
import { evaluateLicenseState, extractFacilityId } from '../license-validator.js';

describe('license validator helpers', () => {
  it('returns VALID before expiry', () => {
    const now = new Date('2026-03-08T10:00:00.000Z');
    const state = evaluateLicenseState({
      now,
      payload: {
        sub: 'facility-1',
        tier: 'PRO',
        features: ['batch_audit', 'export'],
        exp: Math.floor(new Date('2026-03-10T00:00:00.000Z').getTime() / 1000),
      },
    });

    expect(state.status).toBe('VALID');
    expect(state.tier).toBe('PRO');
    expect(state.features).toEqual(['batch_audit', 'export']);
  });

  it('returns GRACE after expiry but before 30 days', () => {
    const now = new Date('2026-03-20T00:00:00.000Z');
    const state = evaluateLicenseState({
      now,
      payload: {
        facilityId: 'facility-1',
        tier: 'PRO',
        features: ['batch_audit'],
        exp: Math.floor(new Date('2026-03-01T00:00:00.000Z').getTime() / 1000),
      },
    });

    expect(state.status).toBe('GRACE');
    expect(state.tier).toBe('PRO');
  });

  it('degrades to FREE after offline grace period', () => {
    const now = new Date('2026-05-01T00:00:00.000Z');
    const state = evaluateLicenseState({
      now,
      payload: {
        facilityId: 'facility-1',
        tier: 'PRO',
        features: ['batch_audit'],
        exp: Math.floor(new Date('2026-03-01T00:00:00.000Z').getTime() / 1000),
      },
    });

    expect(state.status).toBe('EXPIRED');
    expect(state.tier).toBe('FREE');
    expect(state.features).toContain('rule_engine');
  });

  it('extracts facility id from facilityId then sub', () => {
    expect(extractFacilityId({ facilityId: 'abc', sub: 'def' })).toBe('abc');
    expect(extractFacilityId({ sub: 'def' })).toBe('def');
  });
});