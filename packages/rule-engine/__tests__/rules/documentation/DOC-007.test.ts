import { ClaimType, DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { createRuleInput, evaluateRule, makeDocument, setClaimType } from '../helpers/rule-test-helpers.js';

describe('DOC-007: verify_discharge_summary_present_ip', () => {
  it('returns PASS for non-inpatient claims (not applicable)', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.OUTPATIENT);

    const result = evaluateRule('DOC-007', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns PASS for inpatient claims when discharge summary is present', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.INPATIENT);
    input.documents.push(makeDocument({ docType: DocumentType.DISCHARGE_SUMMARY }));

    const result = evaluateRule('DOC-007', input);
    expect(result.result).toBe(RuleResultStatus.PASS);
  });

  it('returns FAIL for inpatient claims when discharge summary is missing', () => {
    const input = createRuleInput();
    setClaimType(input, ClaimType.INPATIENT);

    const result = evaluateRule('DOC-007', input);
    expect(result.result).toBe(RuleResultStatus.FAIL);
  });
});
