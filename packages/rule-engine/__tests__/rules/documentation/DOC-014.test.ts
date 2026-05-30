import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument, makeLine } from '../helpers/rule-test-helpers.js';

describe('DOC-014: verify_prescription_present_if_pharmacy', () => {
  it('returns PASS when no pharmacy lines are claimed', () => {
    const input = createRuleInput();
    input.claim.lines = [makeLine({ description: 'General consultation', shaServiceCode: 'GEN-001' })];

    const result = evaluateRule('DOC-014', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns PASS when pharmacy lines are claimed and prescription exists', () => {
    const input = createRuleInput();
    input.claim.lines = [makeLine({ description: 'Pharmacy medication', shaServiceCode: 'RX-001' })];
    input.documents.push(makeDocument({ docType: DocumentType.PRESCRIPTION }));

    const result = evaluateRule('DOC-014', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when pharmacy lines are claimed but prescription is missing', () => {
    const input = createRuleInput();
    input.claim.lines = [makeLine({ description: 'Pharmacy medication', shaServiceCode: 'RX-001' })];

    const result = evaluateRule('DOC-014', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
