import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, setField } from '../helpers/rule-test-helpers.js';

describe('IDN-010: verify_practitioner_registered', () => {
  it('returns PASS when practitioner exists in registry', () => {
    const input = createRuleInput();
    setField(input, 'physician_reg_no', 'A7816');
    input.registryResults.practitioner = { found: true };

    const result = evaluateRule('IDN-010', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when practitioner is not in registry', () => {
    const input = createRuleInput();
    setField(input, 'physician_reg_no', 'A7816');
    input.registryResults.practitioner = { found: false };

    const result = evaluateRule('IDN-010', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when practitioner registry is unavailable', () => {
    const input = createRuleInput();
    setField(input, 'physician_reg_no', 'A7816');
    input.registryResults.available = false;
    input.registryResults.practitioner = undefined;

    const result = evaluateRule('IDN-010', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
