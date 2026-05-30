import { ClaimType, DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument, setClaimType } from '../helpers/rule-test-helpers.js';

describe('DOC-002: verify_claim_form_type_matches', () => {
  it('returns PASS when claim form type matches claim type', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.INPATIENT);
    input.documents.push(makeDocument({ docType: DocumentType.SHA_CLAIM_FORM_IP }));

    const result = evaluateRule('DOC-002', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL when claim form type does not match claim type', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.MATERNITY);
    input.documents.push(makeDocument({ docType: DocumentType.SHA_CLAIM_FORM_OP }));

    const result = evaluateRule('DOC-002', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });

  it('returns FAIL when no claim form is uploaded', () => {
    const input = createRuleInput();

    const result = evaluateRule('DOC-002', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
