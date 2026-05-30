import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('DOC-008: verify_discharge_summary_signed', () => {
  it('returns PASS when discharge summary signature flag is true', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.DISCHARGE_SUMMARY,
        metadata: { signature_present: true },
      }),
    );

    const result = evaluateRule('DOC-008', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when discharge summary signature flag is false', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.DISCHARGE_SUMMARY,
        metadata: { signature_present: false },
      }),
    );

    const result = evaluateRule('DOC-008', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when signature metadata is unavailable', () => {
    const input = createRuleInput();
    input.documents.push(makeDocument({ docType: DocumentType.DISCHARGE_SUMMARY }));

    const result = evaluateRule('DOC-008', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
