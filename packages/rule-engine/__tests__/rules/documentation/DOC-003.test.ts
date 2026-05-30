import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('DOC-003: verify_physician_signature_present', () => {
  it('returns PASS when physician signature flag is true', () => {
    const input = createRuleInput();
    setField(input, 'physician_signature_present', true);

    const result = evaluateRule('DOC-003', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when physician signature flag is false', () => {
    const input = createRuleInput();
    setField(input, 'physician_signature_present', false);

    const result = evaluateRule('DOC-003', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns FAIL when physician signature flag is missing', () => {
    const input = createRuleInput();

    const result = evaluateRule('DOC-003', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
