import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('DOC-015: verify_prescription_signed', () => {
  it('returns PASS when prescription signature metadata is true', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.PRESCRIPTION,
        metadata: { signature_present: true },
      }),
    );

    const result = evaluateRule('DOC-015', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when prescription signature metadata is false', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.PRESCRIPTION,
        metadata: { signature_present: false },
      }),
    );

    const result = evaluateRule('DOC-015', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when prescription signature metadata is unavailable', () => {
    const input = createRuleInput();
    input.documents.push(makeDocument({ docType: DocumentType.PRESCRIPTION }));

    const result = evaluateRule('DOC-015', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
