import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('IDN-015: verify_patient_contact_present', () => {
  it('returns PASS when patient phone is present', () => {
    const input = createRuleInput();
    setField(input, 'patient_phone', '0712345678');

    const result = evaluateRule('IDN-015', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns PASS when patient address is present', () => {
    const input = createRuleInput();
    setField(input, 'address', 'Thika, Kiambu');

    const result = evaluateRule('IDN-015', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when both phone and address are missing', () => {
    const input = createRuleInput();

    const result = evaluateRule('IDN-015', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
