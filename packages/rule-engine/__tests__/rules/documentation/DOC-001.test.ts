import { ClaimType, DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument, setClaimType } from '../helpers/rule-test-helpers.js';

describe('DOC-001: verify_claim_form_present', () => {
  it('returns PASS when required outpatient claim form exists', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.OUTPATIENT);
    input.documents.push(makeDocument({ docType: DocumentType.SHA_CLAIM_FORM_OP }));

    const result = evaluateRule('DOC-001', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns PASS when required inpatient claim form exists', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.INPATIENT);
    input.documents.push(makeDocument({ docType: DocumentType.SHA_CLAIM_FORM_IP }));

    const result = evaluateRule('DOC-001', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when required claim form is missing', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.MATERNITY);

    const result = evaluateRule('DOC-001', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
