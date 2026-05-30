import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('DOC-006: verify_claim_form_date_matches_admission', () => {
  it('returns PASS when claim form date is within 1 day of admission date', () => {
    const input = createRuleInput();
    input.claim.admissionDate = '2026-03-01';
    setField(input, 'claim_form_date', '2026-03-02');

    const result = evaluateRule('DOC-006', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when claim form date differs by more than 1 day', () => {
    const input = createRuleInput();
    input.claim.admissionDate = '2026-03-01';
    setField(input, 'claim_form_date', '2026-03-10');

    const result = evaluateRule('DOC-006', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when date data is unavailable', () => {
    const input = createRuleInput();
    (input.claim as Record<string, unknown>).admissionDate = undefined;

    const result = evaluateRule('DOC-006', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
