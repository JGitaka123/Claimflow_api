import { ClaimType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { evaluateIdentityRule } from '../../../src/rules/identity.js';
import {
  createRuleInput,
  evaluateRule,
  setClaimType,
  setField,
} from '../helpers/rule-test-helpers.js';

describe('identity branch coverage', () => {
  it('covers additional IDN-001/003/004 branches', () => {
    const idn1 = createRuleInput();
    idn1.claim.patientShaId = 'CR111111111-1';
    idn1.registryResults.patient = { found: false };
    expect(evaluateRule('IDN-001', idn1).result).toBe(RuleResultStatus.FAIL);

    const idn3 = createRuleInput();
    idn3.registryResults.patient = { found: true };
    expect(evaluateRule('IDN-003', idn3).result).toBe(RuleResultStatus.INCOMPLETE);

    const idn4MissingName = createRuleInput();
    idn4MissingName.claim.patientName = null;
    expect(evaluateRule('IDN-004', idn4MissingName).result).toBe(RuleResultStatus.FAIL);

    const idn4RegistryNameMissing = createRuleInput();
    idn4RegistryNameMissing.claim.patientName = 'Julius';
    idn4RegistryNameMissing.registryResults.patient = { found: true, name: '' };
    expect(evaluateRule('IDN-004', idn4RegistryNameMissing).result).toBe(RuleResultStatus.INCOMPLETE);
  });

  it('covers additional IDN-007/008/009/010 failure and incomplete branches', () => {
    const idn7 = createRuleInput();
    setField(idn7, 'dob', 'invalid-date');
    expect(evaluateRule('IDN-007', idn7).result).toBe(RuleResultStatus.FAIL);

    const idn8 = createRuleInput();
    idn8.facilityContext.facilityCode = undefined;
    expect(evaluateRule('IDN-008', idn8).result).toBe(RuleResultStatus.FAIL);

    const idn9ClaimTierMissing = createRuleInput();
    idn9ClaimTierMissing.facilityContext.facilityTier = undefined;
    expect(evaluateRule('IDN-009', idn9ClaimTierMissing).result).toBe(RuleResultStatus.FAIL);

    const idn9RegistryTierMissing = createRuleInput();
    idn9RegistryTierMissing.facilityContext.facilityTier = 'LEVEL_4';
    idn9RegistryTierMissing.registryResults.facility = { found: true };
    expect(evaluateRule('IDN-009', idn9RegistryTierMissing).result).toBe(RuleResultStatus.INCOMPLETE);

    const idn10Missing = createRuleInput();
    expect(evaluateRule('IDN-010', idn10Missing).result).toBe(RuleResultStatus.FAIL);
  });

  it('covers additional IDN-011 branch matrix', () => {
    const expiryMissing = createRuleInput();
    expiryMissing.registryResults.practitioner = { found: true };
    expect(evaluateRule('IDN-011', expiryMissing).result).toBe(RuleResultStatus.INCOMPLETE);

    const expiryUnparseable = createRuleInput();
    expiryUnparseable.registryResults.practitioner = { found: true, licenseExpiryDate: 'not-a-date' };
    expect(evaluateRule('IDN-011', expiryUnparseable).result).toBe(RuleResultStatus.INCOMPLETE);

    const claimDateMissing = createRuleInput();
    claimDateMissing.registryResults.practitioner = { found: true, licenseExpiryDate: '2027-01-01' };
    (claimDateMissing.claim as Record<string, unknown>).admissionDate = undefined;
    expect(evaluateRule('IDN-011', claimDateMissing).result).toBe(RuleResultStatus.INCOMPLETE);
  });

  it('covers additional IDN-012/014/015 branches plus evaluateIdentityRule export', () => {
    const specialtyMissing = createRuleInput();
    specialtyMissing.registryResults.practitioner = { found: true, specialty: '' };
    expect(evaluateRule('IDN-012', specialtyMissing).result).toBe(RuleResultStatus.INCOMPLETE);

    const outpatientPass = createRuleInput();
    outpatientPass.registryResults.practitioner = { found: true, specialty: 'Anything' };
    setClaimType(outpatientPass, ClaimType.OUTPATIENT);
    expect(evaluateRule('IDN-012', outpatientPass).result).toBe(RuleResultStatus.PASS);

    const unknownClaimTypePass = createRuleInput();
    unknownClaimTypePass.registryResults.practitioner = { found: true, specialty: 'Generalist' };
    setClaimType(unknownClaimTypePass, 'UNKNOWN' as ClaimType);
    expect(evaluateRule('IDN-012', unknownClaimTypePass).result).toBe(RuleResultStatus.PASS);

    const noNationalIdDoc = createRuleInput();
    expect(evaluateRule('IDN-014', noNationalIdDoc).result).toBe(RuleResultStatus.FAIL);

    const addressOnly = createRuleInput();
    setField(addressOnly, 'patient_phone', null);
    setField(addressOnly, 'patient_address', 'Thika');
    const idn15AddressOnly = evaluateRule('IDN-015', addressOnly);
    expect(idn15AddressOnly.result).toBe(RuleResultStatus.PASS);
    expect(idn15AddressOnly.evidence?.actual).toBe('Thika');

    const directEval = createRuleInput();
    directEval.claim.patientShaId = 'CR123456789-1';
    directEval.registryResults.patient = { found: true };
    const directResult = evaluateIdentityRule('verify_patient_sha_id_exists', directEval);
    expect(directResult.result).toBe(RuleResultStatus.PASS);

    const nationalIdViaEvaluateIdentityRule = createRuleInput();
    nationalIdViaEvaluateIdentityRule.claim.patientNationalId = '99999999';
    const idn5 = evaluateIdentityRule('verify_national_id_present', nationalIdViaEvaluateIdentityRule);
    expect(idn5.result).toBe(RuleResultStatus.PASS);
  });
});
