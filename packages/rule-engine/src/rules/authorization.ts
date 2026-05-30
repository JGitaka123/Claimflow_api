import { ClaimType, DocumentType } from '@claimflow/shared';
import type { RuleLogicFn } from '../types.js';
import {
  claimDateReference,
  fail,
  getBooleanField,
  getDateField,
  getNumberField,
  getStringField,
  getStringListField,
  hasDocumentType,
  incomplete,
  makeEvidence,
  parseDate,
  pass,
  resolveTariff,
  warning,
} from './utils.js';

const PREAUTH_NUMBER_REGEX = /^(PA|PRA|AUTH)[-_]?[A-Z0-9]{4,}$/i;

function getPreauthNumber(input: Parameters<RuleLogicFn>[0]): string | null {
  if (typeof input.claim.preauthNumber === 'string' && input.claim.preauthNumber.trim().length > 0) {
    return input.claim.preauthNumber.trim();
  }

  return getStringField(input, ['preauth_number', 'preauthorization_number', 'authorization_number']);
}

function isPreauthRequired(input: Parameters<RuleLogicFn>[0]): boolean {
  const explicit = getBooleanField(input, ['preauth_required', 'preauthorization_required']);
  if (explicit === true) {
    return true;
  }

  for (const line of input.claim.lines ?? []) {
    if (typeof line.preauthNumber === 'string' && line.preauthNumber.trim().length > 0) {
      return true;
    }

    if (typeof line.shaServiceCode === 'string' && line.shaServiceCode.trim().length > 0) {
      const tariff = resolveTariff(input, line.shaServiceCode, input.facilityContext.facilityTier ?? 'UNKNOWN');
      if (tariff?.requiresPreauth === true) {
        return true;
      }
    }
  }

  return false;
}

const verifyPreauthExistsIfRequired: RuleLogicFn = (input) => {
  if (!isPreauthRequired(input)) {
    return pass(makeEvidence({ field: 'preauth_required', actual: 'false' }));
  }

  const preauthNumber = getPreauthNumber(input);

  if (!preauthNumber) {
    return fail(makeEvidence({ field: 'preauth_number', expected: 'present when preauth required', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'preauth_number', actual: preauthNumber }));
};

const verifyPreauthNumberValid: RuleLogicFn = (input) => {
  const preauthNumber = getPreauthNumber(input);

  if (!preauthNumber) {
    if (!isPreauthRequired(input)) {
      return pass(makeEvidence({ field: 'preauth_number', actual: 'not_applicable' }));
    }

    return fail(makeEvidence({ field: 'preauth_number', expected: 'valid format', actual: 'missing' }));
  }

  if (!PREAUTH_NUMBER_REGEX.test(preauthNumber)) {
    return fail(makeEvidence({ field: 'preauth_number', expected: 'PA/PRA/AUTH + identifier', actual: preauthNumber }));
  }

  return pass(makeEvidence({ field: 'preauth_number', actual: preauthNumber }));
};

const verifyPreauthNotExpired: RuleLogicFn = (input) => {
  if (!isPreauthRequired(input)) {
    return pass(makeEvidence({ field: 'preauth_expiry_date', actual: 'not_applicable' }));
  }

  const expiryDate = getDateField(input, ['preauth_expiry_date', 'preauthorization_expiry_date']);

  if (!expiryDate) {
    return incomplete('preauth_expiry_missing', makeEvidence({ field: 'preauth_expiry_date' }));
  }

  const serviceDate = claimDateReference(input);

  if (!serviceDate) {
    return incomplete('service_date_unavailable', makeEvidence({ field: 'admission_date' }));
  }

  if (expiryDate.getTime() < serviceDate.getTime()) {
    return fail(makeEvidence({ field: 'preauth_expiry_date', expected: `>= ${serviceDate.toISOString().slice(0, 10)}`, actual: expiryDate.toISOString().slice(0, 10) }));
  }

  return pass(makeEvidence({ field: 'preauth_expiry_date', actual: expiryDate.toISOString().slice(0, 10) }));
};

const verifyPreauthCoversServices: RuleLogicFn = (input) => {
  if (!isPreauthRequired(input)) {
    return pass(makeEvidence({ field: 'preauth_services', actual: 'not_applicable' }));
  }

  const authorizedCodes = getStringListField(input, ['preauth_service_codes', 'authorized_service_codes'])
    .map((code) => code.toUpperCase());

  if (authorizedCodes.length === 0) {
    return incomplete('authorized_service_codes_missing', makeEvidence({ field: 'preauth_service_codes' }));
  }

  for (const line of input.claim.lines ?? []) {
    const code = line.shaServiceCode?.trim().toUpperCase();

    if (code && !authorizedCodes.includes(code)) {
      return fail(makeEvidence({ field: 'preauth_service_codes', expected: `contains ${code}`, actual: authorizedCodes.join(',') }));
    }
  }

  return pass(makeEvidence({ field: 'preauth_service_codes', actual: 'covers_all_claimed_services' }));
};

const verifyPreauthFacilityMatches: RuleLogicFn = (input) => {
  const preauthFacility = getStringField(input, ['preauth_facility_code', 'authorization_facility_code']);

  if (!preauthFacility) {
    if (!isPreauthRequired(input)) {
      return pass(makeEvidence({ field: 'preauth_facility_code', actual: 'not_applicable' }));
    }

    return incomplete('preauth_facility_missing', makeEvidence({ field: 'preauth_facility_code' }));
  }

  const expected = (input.facilityContext.facilityCode ?? '').toUpperCase();

  if (expected.length > 0 && preauthFacility.toUpperCase() !== expected) {
    return fail(makeEvidence({ field: 'preauth_facility_code', expected, actual: preauthFacility }));
  }

  return pass(makeEvidence({ field: 'preauth_facility_code', actual: preauthFacility }));
};

const verifyPreauthPatientMatches: RuleLogicFn = (input) => {
  const authorizedPatient = getStringField(input, ['preauth_patient_sha_id', 'authorized_patient_sha_id']);

  if (!authorizedPatient) {
    if (!isPreauthRequired(input)) {
      return pass(makeEvidence({ field: 'preauth_patient_sha_id', actual: 'not_applicable' }));
    }

    return incomplete('preauth_patient_missing', makeEvidence({ field: 'preauth_patient_sha_id' }));
  }

  const claimPatient = input.claim.patientShaId?.toUpperCase() ?? '';

  if (claimPatient.length === 0) {
    return incomplete('claim_patient_sha_id_missing', makeEvidence({ field: 'patient_sha_id' }));
  }

  if (authorizedPatient.toUpperCase() !== claimPatient) {
    return fail(makeEvidence({ field: 'preauth_patient_sha_id', expected: claimPatient, actual: authorizedPatient }));
  }

  return pass(makeEvidence({ field: 'preauth_patient_sha_id', actual: authorizedPatient }));
};

const verifyBenefitPackageCoversService: RuleLogicFn = (input) => {
  const benefitPackage = input.claim.shaBenefitPackage?.trim().toUpperCase() ?? getStringField(input, ['sha_benefit_package'])?.toUpperCase() ?? null;

  if (!benefitPackage) {
    return incomplete('benefit_package_missing', makeEvidence({ field: 'sha_benefit_package' }));
  }

  const facilityTier = input.facilityContext.facilityTier ?? 'UNKNOWN';

  for (const line of input.claim.lines ?? []) {
    const code = line.shaServiceCode?.trim();
    if (!code) {
      continue;
    }

    const tariff = resolveTariff(input, code, facilityTier);

    if (!tariff) {
      return fail(makeEvidence({ field: 'sha_service_code', expected: 'service covered by active tariff', actual: code }));
    }

    if (tariff.benefitPackage && tariff.benefitPackage.toUpperCase() !== benefitPackage) {
      return fail(makeEvidence({ field: 'sha_benefit_package', expected: tariff.benefitPackage, actual: benefitPackage }));
    }
  }

  return pass(makeEvidence({ field: 'sha_benefit_package', actual: benefitPackage }));
};

const verifyReferralAuthorization: RuleLogicFn = (input) => {
  const referred = getBooleanField(input, ['referred', 'is_referred']) === true || hasDocumentType(input, DocumentType.REFERRAL_LETTER);

  if (!referred) {
    return pass(makeEvidence({ field: 'referral_authorization', actual: 'not_applicable' }));
  }

  const authorized = getBooleanField(input, ['referral_authorized', 'referral_approval_present']);

  if (authorized !== true) {
    return fail(makeEvidence({ field: 'referral_authorization', expected: 'true', actual: `${authorized ?? 'missing'}` }));
  }

  return pass(makeEvidence({ field: 'referral_authorization', actual: 'true' }));
};

const verifyClaimWithinSevenDayWindow: RuleLogicFn = (input) => {
  const submissionDate = getDateField(input, ['submission_date', 'claim_submission_date']) ??
    (typeof input.claim.updatedAt === 'string' ? parseDate(input.claim.updatedAt.slice(0, 10)) : null);
  const dischargeDate = getDateField(input, ['discharge_date']) ??
    (typeof input.claim.dischargeDate === 'string' ? parseDate(input.claim.dischargeDate) : null);
  const serviceReference = dischargeDate ?? claimDateReference(input);

  if (!submissionDate || !serviceReference) {
    return incomplete('submission_or_service_date_missing', makeEvidence({ field: 'submission_date' }));
  }

  const deltaDays = (submissionDate.getTime() - serviceReference.getTime()) / (24 * 60 * 60 * 1000);

  if (deltaDays > 7) {
    return fail(makeEvidence({ field: 'submission_date', expected: '<= 7 days after service', actual: `${deltaDays.toFixed(1)} days` }));
  }

  return pass(makeEvidence({ field: 'submission_date', actual: `${deltaDays.toFixed(1)} days` }));
};

const verifyNoDuplicateClaim: RuleLogicFn = (input) => {
  const duplicateFlag = getBooleanField(input, ['duplicate_claim_detected', 'is_duplicate_claim']);
  const duplicateCount = getNumberField(input, ['duplicate_claim_count', 'dedup_conflict_count']) ?? 0;

  if (duplicateFlag === true || duplicateCount > 0) {
    return fail(makeEvidence({ field: 'duplicate_claim', expected: 'no duplicate claim', actual: `${duplicateFlag ?? false}/${duplicateCount}` }));
  }

  return pass(makeEvidence({ field: 'duplicate_claim', actual: 'no_duplicate_detected' }));
};

const verifyCopayDocumented: RuleLogicFn = (input) => {
  const copayRequired = getBooleanField(input, ['copay_required', 'copayment_required']) === true;

  if (!copayRequired) {
    return pass(makeEvidence({ field: 'copay', actual: 'not_applicable' }));
  }

  const copayAmount = getNumberField(input, ['copay_amount', 'copayment_amount']);

  if (copayAmount === null) {
    return fail(makeEvidence({ field: 'copay_amount', expected: 'documented amount', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'copay_amount', actual: `${copayAmount}` }));
};

const verifyEmergencyRetroauth: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.EMERGENCY) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const retroAuth = getBooleanField(input, ['retroauth_documented', 'emergency_retroauth_present']);

  if (retroAuth === true || hasDocumentType(input, DocumentType.PREAUTH_FORM)) {
    return pass(makeEvidence({ field: 'retroauth', actual: 'present' }));
  }

  return fail(makeEvidence({ field: 'retroauth', expected: 'retroactive authorization evidence', actual: 'missing' }));
};

const verifyCoverageActiveAtService: RuleLogicFn = (input) => {
  const serviceDate = claimDateReference(input);

  if (!serviceDate) {
    return incomplete('service_date_missing', makeEvidence({ field: 'admission_date' }));
  }

  if (input.registryResults.available === false || !input.registryResults.patient) {
    return incomplete('registry_unavailable', makeEvidence({ field: 'patient_coverage' }));
  }

  if (input.registryResults.patient.eligible === false) {
    return fail(makeEvidence({ field: 'patient_coverage', expected: 'active', actual: 'inactive' }));
  }

  const coverageEndDate = getDateField(input, ['coverage_end_date', 'member_coverage_end_date']);

  if (coverageEndDate && coverageEndDate.getTime() < serviceDate.getTime()) {
    return fail(makeEvidence({ field: 'coverage_end_date', expected: `>= ${serviceDate.toISOString().slice(0, 10)}`, actual: coverageEndDate.toISOString().slice(0, 10) }));
  }

  return pass(makeEvidence({ field: 'patient_coverage', actual: 'active' }));
};

const verifyReferralChainComplete: RuleLogicFn = (input) => {
  const tertiaryReferral = getBooleanField(input, ['tertiary_referral', 'is_tertiary_referral']) === true;

  if (!tertiaryReferral) {
    return pass(makeEvidence({ field: 'referral_chain', actual: 'not_applicable' }));
  }

  const chainComplete = getBooleanField(input, ['referral_chain_complete']);

  if (chainComplete !== true) {
    return fail(makeEvidence({ field: 'referral_chain_complete', expected: 'true', actual: `${chainComplete ?? 'missing'}` }));
  }

  return pass(makeEvidence({ field: 'referral_chain_complete', actual: 'true' }));
};

const verifyAuthorizationCompletenessScore: RuleLogicFn = (input) => {
  const checks = [
    !isPreauthRequired(input) || getPreauthNumber(input) !== null,
    !isPreauthRequired(input) || getDateField(input, ['preauth_expiry_date']) !== null,
    getBooleanField(input, ['duplicate_claim_detected']) !== true,
    input.registryResults.patient?.eligible !== false,
    input.claim.shaBenefitPackage !== null,
  ];

  const score = checks.filter(Boolean).length / checks.length;

  if (score < 0.7) {
    return warning(makeEvidence({ field: 'authorization_completeness_score', expected: '>= 0.70', actual: score.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'authorization_completeness_score', actual: score.toFixed(2) }));
};

export const authorizationRuleLogicRegistry: Record<string, RuleLogicFn> = {
  verify_preauth_exists_if_required: verifyPreauthExistsIfRequired,
  verify_preauth_number_valid: verifyPreauthNumberValid,
  verify_preauth_not_expired: verifyPreauthNotExpired,
  verify_preauth_covers_services: verifyPreauthCoversServices,
  verify_preauth_facility_matches: verifyPreauthFacilityMatches,
  verify_preauth_patient_matches: verifyPreauthPatientMatches,
  verify_benefit_package_covers_service: verifyBenefitPackageCoversService,
  verify_referral_authorization: verifyReferralAuthorization,
  verify_claim_within_7_day_window: verifyClaimWithinSevenDayWindow,
  verify_no_duplicate_claim: verifyNoDuplicateClaim,
  verify_copay_documented: verifyCopayDocumented,
  verify_emergency_retroauth: verifyEmergencyRetroauth,
  verify_patient_coverage_active_at_service: verifyCoverageActiveAtService,
  verify_referral_chain_complete: verifyReferralChainComplete,
  verify_authorization_completeness_score: verifyAuthorizationCompletenessScore,
};

export const authorizationRuleIds = {
  'AUT-001': 'verify_preauth_exists_if_required',
  'AUT-002': 'verify_preauth_number_valid',
  'AUT-003': 'verify_preauth_not_expired',
  'AUT-004': 'verify_preauth_covers_services',
  'AUT-005': 'verify_preauth_facility_matches',
  'AUT-006': 'verify_preauth_patient_matches',
  'AUT-007': 'verify_benefit_package_covers_service',
  'AUT-008': 'verify_referral_authorization',
  'AUT-009': 'verify_claim_within_7_day_window',
  'AUT-010': 'verify_no_duplicate_claim',
  'AUT-011': 'verify_copay_documented',
  'AUT-012': 'verify_emergency_retroauth',
  'AUT-013': 'verify_patient_coverage_active_at_service',
  'AUT-014': 'verify_referral_chain_complete',
  'AUT-015': 'verify_authorization_completeness_score',
} as const;
