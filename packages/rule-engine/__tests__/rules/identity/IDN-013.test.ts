import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('IDN-013: verify_sha_card_copy_present', () => {
  it('returns PASS when SHA card copy document is uploaded', () => {
    const input = createRuleInput();
    input.documents.push(makeDocument({ docType: DocumentType.SHA_CARD_COPY }));

    const result = evaluateRule('IDN-013', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when SHA card copy document is missing', () => {
    const input = createRuleInput();

    const result = evaluateRule('IDN-013', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
