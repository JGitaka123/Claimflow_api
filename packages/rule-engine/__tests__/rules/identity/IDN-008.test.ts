import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule } from '../helpers/rule-test-helpers.js';

describe('IDN-008: verify_facility_sha_code_valid', () => {
  it('returns PASS when facility registry confirms facility', () => {
    const input = createRuleInput();
    input.facilityContext.facilityCode = 'FID-22-106718-4';
    input.registryResults.facility = { found: true, code: 'FID-22-106718-4' };

    const result = evaluateRule('IDN-008', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when facility is not found in registry', () => {
    const input = createRuleInput();
    input.facilityContext.facilityCode = 'FID-22-106718-4';
    input.registryResults.facility = { found: false };

    const result = evaluateRule('IDN-008', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when facility registry is unavailable', () => {
    const input = createRuleInput();
    input.registryResults.available = false;
    input.registryResults.facility = undefined;

    const result = evaluateRule('IDN-008', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
