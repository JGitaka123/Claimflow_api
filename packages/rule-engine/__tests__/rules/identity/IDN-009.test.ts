import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule } from '../helpers/rule-test-helpers.js';

describe('IDN-009: verify_facility_tier_matches', () => {
  it('returns PASS when claim and registry facility tiers match', () => {
    const input = createRuleInput();
    input.facilityContext.facilityTier = 'LEVEL_4';
    input.registryResults.facility = { found: true, tier: 'LEVEL_4' };

    const result = evaluateRule('IDN-009', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when claim and registry facility tiers differ', () => {
    const input = createRuleInput();
    input.facilityContext.facilityTier = 'LEVEL_3';
    input.registryResults.facility = { found: true, tier: 'LEVEL_4' };

    const result = evaluateRule('IDN-009', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when facility registry is unavailable', () => {
    const input = createRuleInput();
    input.registryResults.available = false;
    input.registryResults.facility = undefined;

    const result = evaluateRule('IDN-009', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
