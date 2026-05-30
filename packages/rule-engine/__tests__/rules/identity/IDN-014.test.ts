import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('IDN-014: verify_national_id_copy_legible', () => {
  it('returns PASS when national ID copy quality score is above threshold', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.NATIONAL_ID_COPY,
        metadata: { imageQualityScore: 0.8 },
      }),
    );

    const result = evaluateRule('IDN-014', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when national ID copy quality score is low', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.NATIONAL_ID_COPY,
        metadata: { imageQualityScore: 0.4 },
      }),
    );

    const result = evaluateRule('IDN-014', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when quality score is unavailable', () => {
    const input = createRuleInput();
    input.documents.push(makeDocument({ docType: DocumentType.NATIONAL_ID_COPY }));

    const result = evaluateRule('IDN-014', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
