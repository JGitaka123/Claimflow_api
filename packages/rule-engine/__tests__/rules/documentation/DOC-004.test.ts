import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('DOC-004: verify_physician_stamp_present', () => {
  it('returns PASS when physician stamp flag is true', () => {
    const input = createRuleInput();
    setField(input, 'physician_stamp_present', true);

    const result = evaluateRule('DOC-004', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when physician stamp flag is false', () => {
    const input = createRuleInput();
    setField(input, 'physician_stamp_present', false);

    const result = evaluateRule('DOC-004', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns FAIL when physician stamp flag is missing', () => {
    const input = createRuleInput();

    const result = evaluateRule('DOC-004', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
