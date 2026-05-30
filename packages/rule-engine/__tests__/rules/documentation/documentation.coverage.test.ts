import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument } from '../helpers/rule-test-helpers.js';

describe('documentation branch coverage', () => {
  it('covers not-applicable pass branches for DOC-008, DOC-013, and DOC-015', () => {
    const noDischarge = createRuleInput();
    expect(evaluateRule('DOC-008', noDischarge).result).toBe(RuleResultStatus.PASS);

    const noLab = createRuleInput();
    expect(evaluateRule('DOC-013', noLab).result).toBe(RuleResultStatus.PASS);

    const noRx = createRuleInput();
    expect(evaluateRule('DOC-015', noRx).result).toBe(RuleResultStatus.PASS);
  });

  it('covers OCR-unavailable incomplete branches for DOC-010 and DOC-011', () => {
    const diagnosisEmptyText = createRuleInput();
    diagnosisEmptyText.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, textContent: '   ' }));
    expect(evaluateRule('DOC-010', diagnosisEmptyText).result).toBe(RuleResultStatus.INCOMPLETE);

    const treatmentEmptyText = createRuleInput();
    treatmentEmptyText.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, textContent: '   ' }));
    expect(evaluateRule('DOC-011', treatmentEmptyText).result).toBe(RuleResultStatus.INCOMPLETE);
  });
});
