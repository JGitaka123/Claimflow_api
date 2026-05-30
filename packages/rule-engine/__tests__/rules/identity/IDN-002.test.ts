import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule } from '../helpers/rule-test-helpers.js';

describe('IDN-002: verify_patient_sha_id_format', () => {
  it('returns PASS for valid SHA ID format', () => {
    const input = createRuleInput();
    input.claim.patientShaId = 'CR123456789-1';

    const result = evaluateRule('IDN-002', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL for invalid SHA ID format', () => {
    const input = createRuleInput();
    input.claim.patientShaId = '123456789';

    const result = evaluateRule('IDN-002', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns FAIL when SHA ID is missing', () => {
    const input = createRuleInput();
    input.claim.patientShaId = null;

    const result = evaluateRule('IDN-002', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
