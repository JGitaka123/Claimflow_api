import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('IDN-007: verify_patient_dob_consistent', () => {
  it('returns PASS when all DOB fields resolve to the same date', () => {
    const input = createRuleInput();
    setField(input, 'dob', '1990-01-01');
    setField(input, 'patient_dob', '1/01/1990');

    const result = evaluateRule('IDN-007', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when DOB fields conflict', () => {
    const input = createRuleInput();
    setField(input, 'dob', '1990-01-01');
    setField(input, 'patient_dob', '1991-01-01');

    const result = evaluateRule('IDN-007', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when DOB fields are missing', () => {
    const input = createRuleInput();

    const result = evaluateRule('IDN-007', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
