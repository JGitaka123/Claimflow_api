import { ClaimType, DocumentType, type RuleResultStatus } from '@claimflow/shared';
import type { RuleLogicFn } from '../types.js';
import {
  claimDateReference,
  fail,
  getDocumentQualityScore,
  getDocumentsByType,
  getStringField,
  hasDocumentType,
  incomplete,
  makeEvidence,
  normalizedSimilarity,
  parseDate,
  pass,
  registryUnavailable,
  warning,
} from './utils.js';

const SHA_ID_REGEX = /^CR\d{9}-\d$/;

const CLAIM_TYPE_SPECIALTY_KEYWORDS: Record<ClaimType, string[]> = {
  [ClaimType.OUTPATIENT]: [],
  [ClaimType.INPATIENT]: ['internal', 'general', 'family', 'medicine', 'surgery'],
  [ClaimType.MATERNITY]: ['obstetric', 'gyn', 'midwife', 'maternity'],
  [ClaimType.DENTAL]: ['dental', 'dentist', 'oral'],
  [ClaimType.OPTICAL]: ['optometry', 'ophthalm', 'eye', 'optical'],
  [ClaimType.MENTAL_HEALTH]: ['psychi', 'mental', 'counsel'],
  [ClaimType.RENAL]: ['renal', 'nephro', 'dialysis'],
  [ClaimType.SURGICAL]: ['surgery', 'surgeon', 'orthopedic'],
  [ClaimType.EMERGENCY]: ['emergency', 'trauma'],
};

const verifyPatientShaIdExists: RuleLogicFn = (input) => {
  const shaId = input.claim.patientShaId ?? getStringField(input, ['patient_sha_id', 'sha_number']);

  if (!shaId || shaId.trim().length === 0) {
    return fail(
      makeEvidence({ field: 'patient_sha_id', expected: 'non-empty SHA ID', actual: 'missing' }),
    );
  }

  if (registryUnavailable(input.registryResults, 'patient')) {
    return incomplete('registry_unavailable', makeEvidence({ field: 'patient_sha_id', actual: shaId }));
  }

  if (input.registryResults.patient?.found !== true) {
    return fail(
      makeEvidence({ field: 'patient_sha_id', expected: 'found in registry', actual: shaId }),
    );
  }

  return pass(makeEvidence({ field: 'patient_sha_id', actual: shaId }));
};

const verifyPatientShaIdFormat: RuleLogicFn = (input) => {
  const shaId = input.claim.patientShaId ?? getStringField(input, ['patient_sha_id', 'sha_number']);

  if (!shaId || shaId.trim().length === 0) {
    return fail(
      makeEvidence({ field: 'patient_sha_id', expected: 'CRxxxxxxxxx-x', actual: 'missing' }),
    );
  }

  if (!SHA_ID_REGEX.test(shaId.trim().toUpperCase())) {
    return fail(
      makeEvidence({ field: 'patient_sha_id', expected: 'CRxxxxxxxxx-x', actual: shaId }),
    );
  }

  return pass(makeEvidence({ field: 'patient_sha_id', actual: shaId }));
};

const verifyPatientEligibilityActive: RuleLogicFn = (input) => {
  if (registryUnavailable(input.registryResults, 'patient')) {
    return incomplete('registry_unavailable', makeEvidence({ field: 'patient_eligibility' }));
  }

  const eligible = input.registryResults.patient?.eligible;

  if (eligible === undefined) {
    return incomplete('eligibility_missing', makeEvidence({ field: 'patient_eligibility' }));
  }

  if (!eligible) {
    return fail(
      makeEvidence({ field: 'patient_eligibility', expected: 'active', actual: 'inactive' }),
    );
  }

  return pass(makeEvidence({ field: 'patient_eligibility', actual: 'active' }));
};

const verifyPatientNameMatchesRegistry: RuleLogicFn = (input) => {
  const claimName = input.claim.patientName ?? getStringField(input, [
    'patient_name',
    'patient_full_name',
    'patient_last_name',
  ]);

  if (!claimName) {
    return fail(
      makeEvidence({ field: 'patient_name', expected: 'non-empty', actual: 'missing' }),
    );
  }

  if (registryUnavailable(input.registryResults, 'patient')) {
    return incomplete('registry_unavailable', makeEvidence({ field: 'patient_name', actual: claimName }));
  }

  const registryName = input.registryResults.patient?.name;

  if (!registryName || registryName.trim().length === 0) {
    return incomplete('registry_name_missing', makeEvidence({ field: 'patient_name', actual: claimName }));
  }

  const similarity = normalizedSimilarity(claimName, registryName);

  if (similarity < 0.8) {
    return fail(
      makeEvidence({
        field: 'patient_name',
        expected: 'fuzzy similarity >= 0.80',
        actual: similarity.toFixed(2),
      }),
    );
  }

  return pass(
    makeEvidence({
      field: 'patient_name',
      expected: 'fuzzy similarity >= 0.80',
      actual: similarity.toFixed(2),
    }),
  );
};

const verifyNationalIdPresent: RuleLogicFn = (input) => {
  const nationalId = input.claim.patientNationalId ?? getStringField(input, [
    'national_id',
    'patient_national_id',
    'birth_certificate_number',
  ]);

  if (!nationalId) {
    return fail(
      makeEvidence({ field: 'national_id', expected: 'non-empty', actual: 'missing' }),
    );
  }

  return pass(makeEvidence({ field: 'national_id', actual: nationalId }));
};

const verifyPatientGenderConsistent: RuleLogicFn = (input) => {
  const genderValues = ['gender', 'patient_gender', 'sex', 'member_gender']
    .map((key) => getStringField(input, [key]))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.trim().toUpperCase());

  if (genderValues.length === 0) {
    return incomplete('gender_data_unavailable', makeEvidence({ field: 'gender' }));
  }

  const unique = [...new Set(genderValues)];

  if (unique.length > 1) {
    return fail(
      makeEvidence({ field: 'gender', expected: 'consistent', actual: unique.join('|') }),
    );
  }

  return pass(makeEvidence({ field: 'gender', actual: unique[0] }));
};

const verifyPatientDobConsistent: RuleLogicFn = (input) => {
  const dobCandidates = ['dob', 'date_of_birth', 'patient_dob', 'birth_date', 'patient_birth_date']
    .map((key) => getStringField(input, [key]))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (dobCandidates.length === 0) {
    return incomplete('dob_data_unavailable', makeEvidence({ field: 'date_of_birth' }));
  }

  const parsed = dobCandidates
    .map((value) => parseDate(value))
    .filter((value): value is Date => value !== null)
    .map((value) => value.toISOString().slice(0, 10));

  if (parsed.length === 0) {
    return fail(
      makeEvidence({ field: 'date_of_birth', expected: 'parseable date', actual: 'unparseable' }),
    );
  }

  const unique = [...new Set(parsed)];

  if (unique.length > 1) {
    return fail(
      makeEvidence({ field: 'date_of_birth', expected: 'consistent', actual: unique.join('|') }),
    );
  }

  return pass(makeEvidence({ field: 'date_of_birth', actual: unique[0] }));
};

const verifyFacilityShaCodeValid: RuleLogicFn = (input) => {
  const facilityCode = input.facilityContext.facilityCode ?? getStringField(input, ['provider_id', 'facility_code']);

  if (!facilityCode) {
    return fail(
      makeEvidence({ field: 'facility_code', expected: 'non-empty facility SHA code', actual: 'missing' }),
    );
  }

  if (registryUnavailable(input.registryResults, 'facility')) {
    return incomplete('facility_registry_unavailable', makeEvidence({ field: 'facility_code', actual: facilityCode }));
  }

  if (input.registryResults.facility?.found !== true) {
    return fail(
      makeEvidence({ field: 'facility_code', expected: 'registered facility', actual: facilityCode }),
    );
  }

  return pass(makeEvidence({ field: 'facility_code', actual: facilityCode }));
};

const verifyFacilityTierMatches: RuleLogicFn = (input) => {
  const claimTier = input.facilityContext.facilityTier ?? getStringField(input, ['facility_tier', 'provider_tier']);

  if (!claimTier) {
    return fail(makeEvidence({ field: 'facility_tier', expected: 'non-empty', actual: 'missing' }));
  }

  if (registryUnavailable(input.registryResults, 'facility')) {
    return incomplete('facility_registry_unavailable', makeEvidence({ field: 'facility_tier', actual: claimTier }));
  }

  const registryTier = input.registryResults.facility?.tier;

  if (!registryTier) {
    return incomplete('facility_tier_missing_in_registry', makeEvidence({ field: 'facility_tier', actual: claimTier }));
  }

  if (claimTier.trim().toUpperCase() !== registryTier.trim().toUpperCase()) {
    return fail(
      makeEvidence({ field: 'facility_tier', expected: registryTier, actual: claimTier }),
    );
  }

  return pass(makeEvidence({ field: 'facility_tier', expected: registryTier, actual: claimTier }));
};

const verifyPractitionerRegistered: RuleLogicFn = (input) => {
  const practitionerId = getStringField(input, ['physician_reg_no', 'practitioner_id', 'doctor_license_no']);

  if (!practitionerId) {
    return fail(
      makeEvidence({ field: 'practitioner_id', expected: 'non-empty', actual: 'missing' }),
    );
  }

  if (registryUnavailable(input.registryResults, 'practitioner')) {
    return incomplete('practitioner_registry_unavailable', makeEvidence({ field: 'practitioner_id', actual: practitionerId }));
  }

  if (input.registryResults.practitioner?.found !== true) {
    return fail(
      makeEvidence({ field: 'practitioner_id', expected: 'registered', actual: practitionerId }),
    );
  }

  return pass(makeEvidence({ field: 'practitioner_id', actual: practitionerId }));
};

const verifyPractitionerLicenseActive: RuleLogicFn = (input) => {
  if (registryUnavailable(input.registryResults, 'practitioner')) {
    return incomplete('practitioner_registry_unavailable', makeEvidence({ field: 'practitioner_license_expiry' }));
  }

  const expiry = input.registryResults.practitioner?.licenseExpiryDate;

  if (!expiry) {
    return incomplete('license_expiry_missing', makeEvidence({ field: 'practitioner_license_expiry' }));
  }

  const parsedExpiry = parseDate(expiry);

  if (!parsedExpiry) {
    return incomplete('license_expiry_unparseable', makeEvidence({ field: 'practitioner_license_expiry', actual: expiry }));
  }

  const referenceDate = claimDateReference(input);

  if (!referenceDate) {
    return incomplete('claim_date_unavailable', makeEvidence({ field: 'admission_date' }));
  }

  if (parsedExpiry.getTime() < referenceDate.getTime()) {
    return fail(
      makeEvidence({
        field: 'practitioner_license_expiry',
        expected: `>= ${referenceDate.toISOString().slice(0, 10)}`,
        actual: parsedExpiry.toISOString().slice(0, 10),
      }),
    );
  }

  return pass(makeEvidence({ field: 'practitioner_license_expiry', actual: parsedExpiry.toISOString().slice(0, 10) }));
};

const verifyPractitionerSpecialtyAppropriate: RuleLogicFn = (input) => {
  if (registryUnavailable(input.registryResults, 'practitioner')) {
    return incomplete('practitioner_registry_unavailable', makeEvidence({ field: 'practitioner_specialty' }));
  }

  const specialty = input.registryResults.practitioner?.specialty;

  if (!specialty || specialty.trim().length === 0) {
    return incomplete('practitioner_specialty_missing', makeEvidence({ field: 'practitioner_specialty' }));
  }

  const claimType = input.claim.claimType;

  if (claimType === ClaimType.OUTPATIENT) {
    return pass(makeEvidence({ field: 'practitioner_specialty', actual: specialty }));
  }

  const expectedKeywords = CLAIM_TYPE_SPECIALTY_KEYWORDS[claimType] ?? [];

  if (expectedKeywords.length === 0) {
    return pass(makeEvidence({ field: 'practitioner_specialty', actual: specialty }));
  }

  const normalizedSpecialty = specialty.toLowerCase();
  const matches = expectedKeywords.some((keyword) => normalizedSpecialty.includes(keyword));

  if (!matches) {
    return warning(
      makeEvidence({
        field: 'practitioner_specialty',
        expected: expectedKeywords.join('|'),
        actual: specialty,
      }),
    );
  }

  return pass(makeEvidence({ field: 'practitioner_specialty', actual: specialty }));
};

const verifyShaCardCopyPresent: RuleLogicFn = (input) => {
  if (!hasDocumentType(input, DocumentType.SHA_CARD_COPY)) {
    return fail(
      makeEvidence({ field: 'documents', expected: DocumentType.SHA_CARD_COPY, actual: 'missing' }),
    );
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.SHA_CARD_COPY }));
};

const verifyNationalIdCopyLegible: RuleLogicFn = (input) => {
  const nationalIdDocs = getDocumentsByType(input, DocumentType.NATIONAL_ID_COPY);

  if (nationalIdDocs.length === 0) {
    return fail(
      makeEvidence({ field: 'documents', expected: DocumentType.NATIONAL_ID_COPY, actual: 'missing' }),
    );
  }

  const qualityScores = nationalIdDocs
    .map((document) => ({ document, score: getDocumentQualityScore(document) }))
    .filter((entry): entry is { document: (typeof nationalIdDocs)[number]; score: number } => entry.score !== null);

  if (qualityScores.length === 0) {
    return incomplete('quality_score_unavailable', makeEvidence({ field: 'image_quality_score' }));
  }

  const best = qualityScores.reduce((highest, current) => (current.score > highest.score ? current : highest));

  if (best.score <= 0.5) {
    return fail(
      makeEvidence({
        field: 'image_quality_score',
        expected: '> 0.5',
        actual: best.score.toFixed(2),
        documentId: best.document.id,
      }),
    );
  }

  return pass(
    makeEvidence({
      field: 'image_quality_score',
      expected: '> 0.5',
      actual: best.score.toFixed(2),
      documentId: best.document.id,
    }),
  );
};

const verifyPatientContactPresent: RuleLogicFn = (input) => {
  const phone = getStringField(input, ['patient_phone', 'phone_number', 'contact_phone', 'mobile_number']);
  const address = getStringField(input, ['patient_address', 'address', 'residence', 'contact_address']);

  if (!phone && !address) {
    return fail(
      makeEvidence({ field: 'patient_contact', expected: 'phone or address', actual: 'missing' }),
    );
  }

  return pass(
    makeEvidence({
      field: 'patient_contact',
      expected: 'phone or address',
      actual: phone ?? address ?? undefined,
    }),
  );
};

export const identityRuleLogicRegistry: Record<string, RuleLogicFn> = {
  verify_patient_sha_id_exists: verifyPatientShaIdExists,
  verify_patient_sha_id_format: verifyPatientShaIdFormat,
  verify_patient_eligibility_active: verifyPatientEligibilityActive,
  verify_patient_name_matches_registry: verifyPatientNameMatchesRegistry,
  verify_national_id_present: verifyNationalIdPresent,
  verify_patient_gender_consistent: verifyPatientGenderConsistent,
  verify_patient_dob_consistent: verifyPatientDobConsistent,
  verify_facility_sha_code_valid: verifyFacilityShaCodeValid,
  verify_facility_tier_matches: verifyFacilityTierMatches,
  verify_practitioner_registered: verifyPractitionerRegistered,
  verify_practitioner_license_active: verifyPractitionerLicenseActive,
  verify_practitioner_specialty_appropriate: verifyPractitionerSpecialtyAppropriate,
  verify_sha_card_copy_present: verifyShaCardCopyPresent,
  verify_national_id_copy_legible: verifyNationalIdCopyLegible,
  verify_patient_contact_present: verifyPatientContactPresent,
};

export const identityRuleIds = {
  'IDN-001': 'verify_patient_sha_id_exists',
  'IDN-002': 'verify_patient_sha_id_format',
  'IDN-003': 'verify_patient_eligibility_active',
  'IDN-004': 'verify_patient_name_matches_registry',
  'IDN-005': 'verify_national_id_present',
  'IDN-006': 'verify_patient_gender_consistent',
  'IDN-007': 'verify_patient_dob_consistent',
  'IDN-008': 'verify_facility_sha_code_valid',
  'IDN-009': 'verify_facility_tier_matches',
  'IDN-010': 'verify_practitioner_registered',
  'IDN-011': 'verify_practitioner_license_active',
  'IDN-012': 'verify_practitioner_specialty_appropriate',
  'IDN-013': 'verify_sha_card_copy_present',
  'IDN-014': 'verify_national_id_copy_legible',
  'IDN-015': 'verify_patient_contact_present',
} as const;

export type IdentityRuleId = keyof typeof identityRuleIds;
export type IdentityLogicKey = (typeof identityRuleIds)[IdentityRuleId];

export function evaluateIdentityRule(logicKey: IdentityLogicKey, input: Parameters<RuleLogicFn>[0]): {
  result: RuleResultStatus;
  evidence?: ReturnType<typeof makeEvidence>;
} {
  const evaluator = identityRuleLogicRegistry[logicKey];

  if (!evaluator) {
    throw new Error(`Unknown identity logic key: ${logicKey}`);
  }

  return evaluator(input, {});
}



