import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('IDN-006: verify_patient_gender_consistent', () => {
  it('returns PASS when all gender fields agree', () => {
    const input = createRuleInput();
    setField(input, 'gender', 'Male');
    setField(input, 'patient_gender', 'male');

    const result = evaluateRule('IDN-006', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when gender fields conflict', () => {
    const input = createRuleInput();
    setField(input, 'gender', 'Male');
    setField(input, 'patient_gender', 'Female');

    const result = evaluateRule('IDN-006', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when no gender fields are available', () => {
    const input = createRuleInput();

    const result = evaluateRule('IDN-006', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
