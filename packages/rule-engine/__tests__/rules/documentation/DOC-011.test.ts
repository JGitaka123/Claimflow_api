import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('DOC-011: verify_treatment_plan_documented', () => {
  it('returns PASS when treatment plan keyword is present in notes', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.PHYSICIAN_NOTES,
        textContent: 'Treatment plan: continue dialysis and monitor vitals',
      }),
    );

    const result = evaluateRule('DOC-011', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when treatment plan keyword is missing', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.PHYSICIAN_NOTES,
        textContent: 'Patient seen and discharged.',
      }),
    );

    const result = evaluateRule('DOC-011', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when physician notes are missing for text check', () => {
    const input = createRuleInput();

    const result = evaluateRule('DOC-011', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
