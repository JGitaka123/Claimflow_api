import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('IDN-005: verify_national_id_present', () => {
  it('returns PASS when national ID exists on claim', () => {
    const input = createRuleInput();
    input.claim.patientNationalId = '12345678';

    const result = evaluateRule('IDN-005', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns PASS when national ID is extracted from documents', () => {
    const input = createRuleInput();
    input.claim.patientNationalId = null;
    setField(input, 'national_id', '98765432');

    const result = evaluateRule('IDN-005', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when no national ID is available', () => {
    const input = createRuleInput();
    input.claim.patientNationalId = null;

    const result = evaluateRule('IDN-005', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
