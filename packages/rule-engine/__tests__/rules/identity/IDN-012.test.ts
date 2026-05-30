import { ClaimType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setClaimType } from '../helpers/rule-test-helpers.js';

describe('IDN-012: verify_practitioner_specialty_appropriate', () => {
  it('returns PASS when specialty aligns with claim type', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.MATERNITY);
    input.registryResults.practitioner = { found: true, specialty: 'Obstetrics and Gynecology' };

    const result = evaluateRule('IDN-012', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns WARNING when specialty does not align with claim type', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.MATERNITY);
    input.registryResults.practitioner = { found: true, specialty: 'Dental Surgery' };

    const result = evaluateRule('IDN-012', input);
    expect(result.result).toBe(RuleResultStatus.WARNING);
  });

  it('returns INCOMPLETE when practitioner registry is unavailable', () => {
    const input = createRuleInput();
    input.registryResults.available = false;
    input.registryResults.practitioner = undefined;

    const result = evaluateRule('IDN-012', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
