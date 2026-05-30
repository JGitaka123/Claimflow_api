import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('DOC-005: verify_claim_form_date_present', () => {
  it('returns PASS when claim form date is parseable', () => {
    const input = createRuleInput();
    setField(input, 'claim_form_date', '2026-03-01');

    const result = evaluateRule('DOC-005', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when claim form date is invalid', () => {
    const input = createRuleInput();
    setField(input, 'claim_form_date', 'not-a-date');

    const result = evaluateRule('DOC-005', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns FAIL when claim form date is missing', () => {
    const input = createRuleInput();

    const result = evaluateRule('DOC-005', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
