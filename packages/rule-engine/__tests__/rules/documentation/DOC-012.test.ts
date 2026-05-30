import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument, makeLine } from '../helpers/rule-test-helpers.js';

describe('DOC-012: verify_lab_results_present_if_claimed', () => {
  it('returns PASS when no lab lines are claimed', () => {
    const input = createRuleInput();
    input.claim.lines = [makeLine({ description: 'General consultation' })];

    const result = evaluateRule('DOC-012', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns PASS when lab lines are claimed and lab results document exists', () => {
    const input = createRuleInput();
    input.claim.lines = [makeLine({ description: 'Laboratory test - CBC', shaServiceCode: 'LAB-001' })];
    input.documents.push(makeDocument({ docType: DocumentType.LAB_RESULTS }));

    const result = evaluateRule('DOC-012', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when lab lines are claimed but lab results document is missing', () => {
    const input = createRuleInput();
    input.claim.lines = [makeLine({ description: 'Laboratory test - CBC', shaServiceCode: 'LAB-001' })];

    const result = evaluateRule('DOC-012', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
