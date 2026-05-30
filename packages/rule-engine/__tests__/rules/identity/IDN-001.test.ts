import { RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule } from '../helpers/rule-test-helpers.js';

describe('IDN-001: verify_patient_sha_id_exists', () => {
  it('returns PASS when SHA ID exists and registry confirms patient', () => {
    const input = createRuleInput();
    input.claim.patientShaId = 'CR123456789-1';
    input.registryResults.patient = { found: true };

    const result = evaluateRule('IDN-001', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when SHA ID is missing', () => {
    const input = createRuleInput();
    input.claim.patientShaId = null;

    const result = evaluateRule('IDN-001', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
    expect(result.evidence?.field).toBe('patient_sha_id');
  });

  it('returns INCOMPLETE when registry is unavailable', () => {
    const input = createRuleInput();
    input.claim.patientShaId = 'CR123456789-1';
    input.registryResults.available = false;
    input.registryResults.patient = undefined;

    const result = evaluateRule('IDN-001', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
