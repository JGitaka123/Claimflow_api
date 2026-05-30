import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('DOC-013: verify_lab_results_from_accredited', () => {
  it('returns PASS when lab result has facility header metadata', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.LAB_RESULTS,
        metadata: { facility_header_present: true },
      }),
    );

    const result = evaluateRule('DOC-013', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when lab result indicates missing facility header', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.LAB_RESULTS,
        metadata: { facility_header_present: false },
      }),
    );

    const result = evaluateRule('DOC-013', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when facility header metadata is unavailable', () => {
    const input = createRuleInput();
    input.documents.push(makeDocument({ docType: DocumentType.LAB_RESULTS }));

    const result = evaluateRule('DOC-013', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
