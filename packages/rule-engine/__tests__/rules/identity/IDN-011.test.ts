import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule } from '../helpers/rule-test-helpers.js';

describe('IDN-011: verify_practitioner_license_active', () => {
  it('returns PASS when license expiry is after claim date', () => {
    const input = createRuleInput();
    input.claim.admissionDate = '2026-03-01';
    input.registryResults.practitioner = { found: true, licenseExpiryDate: '2026-12-31' };

    const result = evaluateRule('IDN-011', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when license is expired before claim date', () => {
    const input = createRuleInput();
    input.claim.admissionDate = '2026-03-01';
    input.registryResults.practitioner = { found: true, licenseExpiryDate: '2025-12-31' };

    const result = evaluateRule('IDN-011', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when practitioner registry is unavailable', () => {
    const input = createRuleInput();
    input.registryResults.available = false;
    input.registryResults.practitioner = undefined;

    const result = evaluateRule('IDN-011', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
