import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule } from '../helpers/rule-test-helpers.js';

describe('IDN-004: verify_patient_name_matches_registry', () => {
  it('returns PASS when patient names are a close fuzzy match', () => {
    const input = createRuleInput();
    input.claim.patientName = 'Julius Kithuva';
    input.registryResults.patient = { found: true, name: 'Julius Kithuva' };

    const result = evaluateRule('IDN-004', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when patient names are different', () => {
    const input = createRuleInput();
    input.claim.patientName = 'Alice Doe';
    input.registryResults.patient = { found: true, name: 'John Smith' };

    const result = evaluateRule('IDN-004', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when patient registry lookup is unavailable', () => {
    const input = createRuleInput();
    input.claim.patientName = 'Julius Kithuva';
    input.registryResults.available = false;
    input.registryResults.patient = undefined;

    const result = evaluateRule('IDN-004', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
