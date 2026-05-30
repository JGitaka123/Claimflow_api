import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule } from '../helpers/rule-test-helpers.js';

describe('IDN-003: verify_patient_eligibility_active', () => {
  it('returns PASS when registry marks patient as eligible', () => {
    const input = createRuleInput();
    input.registryResults.patient = { found: true, eligible: true };

    const result = evaluateRule('IDN-003', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when patient eligibility is inactive', () => {
    const input = createRuleInput();
    input.registryResults.patient = { found: true, eligible: false };

    const result = evaluateRule('IDN-003', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when patient registry lookup is unavailable', () => {
    const input = createRuleInput();
    input.registryResults.available = false;
    input.registryResults.patient = undefined;

    const result = evaluateRule('IDN-003', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
