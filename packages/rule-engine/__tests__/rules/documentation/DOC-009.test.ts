import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('DOC-009: verify_physician_notes_present', () => {
  it('returns PASS when physician notes document exists', () => {
    const input = createRuleInput();
    input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES }));

    const result = evaluateRule('DOC-009', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when physician notes document is missing', () => {
    const input = createRuleInput();

    const result = evaluateRule('DOC-009', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
