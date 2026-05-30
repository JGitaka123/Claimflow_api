import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('DOC-010: verify_diagnosis_documented_in_notes', () => {
  it('returns PASS when physician notes include diagnosis keyword', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.PHYSICIAN_NOTES,
        textContent: 'Diagnosis: chronic kidney disease',
      }),
    );

    const result = evaluateRule('DOC-010', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when diagnosis keyword is missing from physician notes text', () => {
    const input = createRuleInput();
    input.documents.push(
      makeDocument({
        docType: DocumentType.PHYSICIAN_NOTES,
        textContent: 'Patient stable and advised follow up.',
      }),
    );

    const result = evaluateRule('DOC-010', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns INCOMPLETE when physician notes are unavailable for text check', () => {
    const input = createRuleInput();

    const result = evaluateRule('DOC-010', input);
    expect(result.result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
