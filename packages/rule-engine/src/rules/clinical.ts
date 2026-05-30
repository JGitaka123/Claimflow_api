import { ClaimType, DocumentType } from '@claimflow/shared';
import type { RuleLogicFn } from '../types.js';
import {
  claimDateReference,
  fail,
  getBooleanField,
  getDateField,
  getDocumentsByType,
  getNumberField,
  getStringField,
  getStringListField,
  hasDocumentType,
  hasLineCategory,
  incomplete,
  makeEvidence,
  parseDate,
  pass,
  warning,
} from './utils.js';

function getPrimaryDiagnosisCode(input: Parameters<RuleLogicFn>[0]): string | null {
  if (typeof input.claim.primaryDiagnosisCode === 'string' && input.claim.primaryDiagnosisCode.trim().length > 0) {
    return input.claim.primaryDiagnosisCode.trim().toUpperCase();
  }

  return getStringField(input, ['primary_diagnosis_code', 'diagnosis_code'])?.toUpperCase() ?? null;
}

function getDiagnosisText(input: Parameters<RuleLogicFn>[0]): string {
  return (
    getStringField(input, ['diagnosis', 'diagnosis_text', 'primary_diagnosis', 'clinical_diagnosis']) ??
    getPrimaryDiagnosisCode(input) ??
    ''
  ).toLowerCase();
}

function getPatientAge(input: Parameters<RuleLogicFn>[0]): number | null {
  const explicitAge = getNumberField(input, ['patient_age', 'age_years']);

  if (explicitAge !== null) {
    return explicitAge;
  }

  const dob = getDateField(input, ['dob', 'date_of_birth', 'patient_dob']);
  const referenceDate = claimDateReference(input);

  if (!dob || !referenceDate) {
    return null;
  }

  const years = (referenceDate.getTime() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return years >= 0 ? years : null;
}

function getPatientGender(input: Parameters<RuleLogicFn>[0]): string | null {
  return getStringField(input, ['gender', 'patient_gender', 'sex'])?.toUpperCase() ?? null;
}


function hasProcedureData(input: Parameters<RuleLogicFn>[0]): boolean {
  return (input.claim.lines ?? []).some(
    (line) =>
      (typeof line.procedureCode === 'string' && line.procedureCode.trim().length > 0) ||
      (typeof line.shaServiceCode === 'string' && line.shaServiceCode.trim().length > 0),
  );
}

const verifyIcdCodeValid: RuleLogicFn = (input) => {
  const code = getPrimaryDiagnosisCode(input);

  if (!code) {
    return fail(makeEvidence({ field: 'primary_diagnosis_code', expected: 'non-empty ICD-11 code', actual: 'missing' }));
  }

  if (!input.icdLookup) {
    return incomplete('icd_lookup_unavailable', makeEvidence({ field: 'primary_diagnosis_code', actual: code }));
  }

  if (!input.icdLookup.isValidCode(code)) {
    return fail(makeEvidence({ field: 'primary_diagnosis_code', expected: 'valid ICD-11 code', actual: code }));
  }

  return pass(makeEvidence({ field: 'primary_diagnosis_code', actual: code }));
};

const verifyIcdCodeSpecificity: RuleLogicFn = (input) => {
  const code = getPrimaryDiagnosisCode(input);

  if (!code) {
    return fail(makeEvidence({ field: 'primary_diagnosis_code', expected: 'leaf ICD-11 code', actual: 'missing' }));
  }

  if (!input.icdLookup) {
    return incomplete('icd_lookup_unavailable', makeEvidence({ field: 'primary_diagnosis_code', actual: code }));
  }

  if (!input.icdLookup.isLeafCode(code)) {
    return fail(makeEvidence({ field: 'primary_diagnosis_code', expected: 'leaf ICD-11 code', actual: code }));
  }

  return pass(makeEvidence({ field: 'primary_diagnosis_code', actual: code }));
};

const verifyDiagnosisMatchesClaimType: RuleLogicFn = (input) => {
  const diagnosisText = getDiagnosisText(input);

  if (diagnosisText.length === 0) {
    return incomplete('diagnosis_text_unavailable', makeEvidence({ field: 'diagnosis_text' }));
  }

  if (input.claim.claimType === ClaimType.MATERNITY && !/(pregnan|mater|obstet|delivery|postpartum)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'diagnosis_text', expected: 'maternity-related diagnosis', actual: diagnosisText }));
  }

  if (input.claim.claimType === ClaimType.DENTAL && !/(dental|tooth|gingiv|oral|jaw)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'diagnosis_text', expected: 'dental-related diagnosis', actual: diagnosisText }));
  }

  if (input.claim.claimType === ClaimType.OPTICAL && !/(eye|optic|vision|retina|cornea)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'diagnosis_text', expected: 'optical-related diagnosis', actual: diagnosisText }));
  }

  if (input.claim.claimType === ClaimType.RENAL && !/(renal|kidney|dialysis|nephro)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'diagnosis_text', expected: 'renal-related diagnosis', actual: diagnosisText }));
  }

  return pass(makeEvidence({ field: 'diagnosis_text', actual: diagnosisText }));
};

const verifyProcedureMatchesDiagnosis: RuleLogicFn = (input) => {
  if (!hasProcedureData(input)) {
    return pass(makeEvidence({ field: 'procedures', actual: 'not_applicable' }));
  }

  const diagnosisText = getDiagnosisText(input);

  if (diagnosisText.length === 0) {
    return incomplete('diagnosis_text_unavailable', makeEvidence({ field: 'diagnosis_text' }));
  }

  const hasDialysisProcedure = hasLineCategory(input, {
    keywords: ['dialysis', 'hemodialysis', 'peritoneal'],
    codePrefixes: ['REN', 'DIAL'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (hasDialysisProcedure && !/(renal|kidney|dialysis|nephro)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'procedures', expected: 'renal diagnosis for dialysis', actual: diagnosisText }));
  }

  return pass(makeEvidence({ field: 'procedures', actual: 'consistent' }));
};

const verifyProcedureCodeValid: RuleLogicFn = (input) => {
  const lines = input.claim.lines ?? [];

  if (lines.length === 0) {
    return fail(makeEvidence({ field: 'claim_lines', expected: 'at least one coded line', actual: 'missing' }));
  }

  const codes = lines
    .map((line) => line.shaServiceCode?.trim().toUpperCase())
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (codes.length !== lines.length) {
    return fail(makeEvidence({ field: 'sha_service_code', expected: 'non-empty for all lines', actual: 'missing' }));
  }

  const tariffIndex = input.tariffs.byServiceCode;

  if (!tariffIndex && !input.tariffs.getTariff) {
    return incomplete('tariff_lookup_unavailable', makeEvidence({ field: 'sha_service_code' }));
  }

  for (const code of codes) {
    const existsInIndex = tariffIndex ? Array.isArray(tariffIndex[code]) && tariffIndex[code].length > 0 : false;
    const existsViaLookup = input.tariffs.getTariff
      ? input.tariffs.getTariff(code, input.facilityContext.facilityTier ?? 'UNKNOWN') !== null
      : false;

    if (!existsInIndex && !existsViaLookup) {
      return fail(makeEvidence({ field: 'sha_service_code', expected: 'valid code', actual: code }));
    }
  }

  return pass(makeEvidence({ field: 'sha_service_code', actual: 'all_valid' }));
};

const verifyLosAppropriate: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.INPATIENT) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const admissionDate = getDateField(input, ['admission_date']) ??
    (typeof input.claim.admissionDate === 'string' ? parseDate(input.claim.admissionDate) : null);
  const dischargeDate = getDateField(input, ['discharge_date']) ??
    (typeof input.claim.dischargeDate === 'string' ? parseDate(input.claim.dischargeDate) : null);

  if (!admissionDate || !dischargeDate) {
    return incomplete('los_data_unavailable', makeEvidence({ field: 'length_of_stay' }));
  }

  const losDays = Math.ceil((dischargeDate.getTime() - admissionDate.getTime()) / (24 * 60 * 60 * 1000));

  if (losDays < 0 || losDays > 60) {
    return fail(makeEvidence({ field: 'length_of_stay', expected: '0-60 days', actual: `${losDays}` }));
  }

  return pass(makeEvidence({ field: 'length_of_stay', actual: `${losDays}` }));
};

const verifyMedicationsMatchDiagnosis: RuleLogicFn = (input) => {
  const hasPharmacy = hasLineCategory(input, {
    keywords: ['pharmacy', 'medication', 'drug'],
    codePrefixes: ['RX', 'PHARM'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!hasPharmacy) {
    return pass(makeEvidence({ field: 'pharmacy_lines', actual: 'not_applicable' }));
  }

  const diagnosisText = getDiagnosisText(input);

  if (diagnosisText.length === 0) {
    return fail(makeEvidence({ field: 'diagnosis_text', expected: 'diagnosis for medication context', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'pharmacy_lines', actual: 'diagnosis_present' }));
};

const verifyLabTestsRelevant: RuleLogicFn = (input) => {
  const hasLab = hasLineCategory(input, {
    keywords: ['lab', 'laboratory', 'pathology', 'test'],
    codePrefixes: ['LAB'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!hasLab) {
    return pass(makeEvidence({ field: 'lab_lines', actual: 'not_applicable' }));
  }

  const diagnosisText = getDiagnosisText(input);

  if (diagnosisText.length === 0) {
    return incomplete('diagnosis_text_unavailable', makeEvidence({ field: 'diagnosis_text' }));
  }

  if (/(fracture|sprain|laceration)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'lab_lines', expected: 'lab relevance to diagnosis', actual: diagnosisText }));
  }

  return pass(makeEvidence({ field: 'lab_lines', actual: 'diagnosis_context_available' }));
};

const verifyNoClinicalContradictions: RuleLogicFn = (input) => {
  const gender = getPatientGender(input);

  if (input.claim.claimType === ClaimType.MATERNITY && gender === 'M') {
    return fail(makeEvidence({ field: 'gender', expected: 'female for maternity', actual: 'male' }));
  }

  return pass(makeEvidence({ field: 'clinical_consistency', actual: 'no_contradictions_detected' }));
};

const verifyAgeAppropriateDiagnosis: RuleLogicFn = (input) => {
  const age = getPatientAge(input);
  const diagnosisText = getDiagnosisText(input);

  if (age === null || diagnosisText.length === 0) {
    return incomplete('age_or_diagnosis_unavailable', makeEvidence({ field: 'age_appropriateness' }));
  }

  if (age < 12 && /(prostate|benign prostatic|bph)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'age_appropriateness', expected: 'diagnosis plausible for age', actual: `${age}` }));
  }

  if (age < 15 && /(pregnan|maternal|antenatal)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'age_appropriateness', expected: 'diagnosis plausible for age', actual: `${age}` }));
  }

  return pass(makeEvidence({ field: 'age_appropriateness', actual: `${age}` }));
};

const verifyGenderAppropriateDiagnosis: RuleLogicFn = (input) => {
  const gender = getPatientGender(input);
  const diagnosisText = getDiagnosisText(input);

  if (!gender || diagnosisText.length === 0) {
    return incomplete('gender_or_diagnosis_unavailable', makeEvidence({ field: 'gender_appropriateness' }));
  }

  if (gender.startsWith('M') && /(pregnan|ovarian|uterine|cervical)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'gender_appropriateness', expected: 'male-compatible diagnosis', actual: diagnosisText }));
  }

  if (gender.startsWith('F') && /(prostate|testicular)/i.test(diagnosisText)) {
    return fail(makeEvidence({ field: 'gender_appropriateness', expected: 'female-compatible diagnosis', actual: diagnosisText }));
  }

  return pass(makeEvidence({ field: 'gender_appropriateness', actual: gender }));
};

const verifyMaternityGestationalAge: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.MATERNITY) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const gestationalAge = getNumberField(input, ['gestational_age_weeks', 'ga_weeks']);

  if (gestationalAge === null) {
    return fail(makeEvidence({ field: 'gestational_age_weeks', expected: 'documented gestational age', actual: 'missing' }));
  }

  if (gestationalAge < 4 || gestationalAge > 45) {
    return fail(makeEvidence({ field: 'gestational_age_weeks', expected: '4-45', actual: `${gestationalAge}` }));
  }

  return pass(makeEvidence({ field: 'gestational_age_weeks', actual: `${gestationalAge}` }));
};

const verifyVitalSignsDocumented: RuleLogicFn = (input) => {
  const hasVitals =
    getStringField(input, ['blood_pressure', 'bp']) !== null ||
    getNumberField(input, ['heart_rate', 'pulse']) !== null ||
    getNumberField(input, ['temperature', 'temp_c']) !== null ||
    getNumberField(input, ['respiratory_rate', 'rr']) !== null;

  if (!hasVitals) {
    return fail(makeEvidence({ field: 'vital_signs', expected: 'at least one vital sign', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'vital_signs', actual: 'documented' }));
};

const verifyAdmissionCriteriaMetIp: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.INPATIENT) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const met = getBooleanField(input, ['admission_criteria_met', 'ip_admission_criteria_met']);

  if (met === null) {
    return incomplete('admission_criteria_missing', makeEvidence({ field: 'admission_criteria_met' }));
  }

  if (!met) {
    return fail(makeEvidence({ field: 'admission_criteria_met', expected: 'true', actual: 'false' }));
  }

  return pass(makeEvidence({ field: 'admission_criteria_met', actual: 'true' }));
};

const verifyFollowUpPlanDocumented: RuleLogicFn = (input) => {
  const diagnosisText = getDiagnosisText(input);
  const chronicDiagnosis = /(diabet|hypertens|asthma|renal|hiv|epilep|heart failure)/i.test(diagnosisText);

  if (!chronicDiagnosis) {
    return pass(makeEvidence({ field: 'follow_up_plan', actual: 'not_applicable' }));
  }

  const followUpPresent = getBooleanField(input, ['follow_up_plan_present', 'followup_plan_present']);

  if (followUpPresent === true) {
    return pass(makeEvidence({ field: 'follow_up_plan', actual: 'documented' }));
  }

  return fail(makeEvidence({ field: 'follow_up_plan', expected: 'documented for chronic condition', actual: 'missing' }));
};

const verifyEmergencyTriageDocumented: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.EMERGENCY) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const triageDocumented = getBooleanField(input, ['triage_documented', 'emergency_triage_present']);

  if (triageDocumented !== true) {
    return fail(makeEvidence({ field: 'triage_documented', expected: 'true', actual: `${triageDocumented ?? 'missing'}` }));
  }

  return pass(makeEvidence({ field: 'triage_documented', actual: 'true' }));
};

const verifyAllergyDocumentation: RuleLogicFn = (input) => {
  const allergyStatus = getStringField(input, ['allergy_status', 'allergies']);

  if (!allergyStatus) {
    return fail(makeEvidence({ field: 'allergy_status', expected: 'documented', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'allergy_status', actual: allergyStatus }));
};

const verifyDentalChartIfDental: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.DENTAL) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const hasDentalChartField = getBooleanField(input, ['dental_chart_present']) === true;
  const hasDentalChartDoc = input.documents.some((document) => {
    const metadataKind = typeof document.metadata?.document_kind === 'string' ? document.metadata.document_kind.toLowerCase() : '';
    const text = `${document.textContent ?? ''}`.toLowerCase();
    return metadataKind.includes('dental') || text.includes('dental chart');
  });

  if (!hasDentalChartField && !hasDentalChartDoc) {
    return fail(makeEvidence({ field: 'dental_chart', expected: 'present', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'dental_chart', actual: 'present' }));
};

const verifyOpticalPrescriptionIfOptical: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.OPTICAL) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const opticalPrescriptionFlag = getBooleanField(input, ['optical_prescription_present']);

  if (opticalPrescriptionFlag !== true && !hasDocumentType(input, DocumentType.PRESCRIPTION)) {
    return fail(makeEvidence({ field: 'optical_prescription', expected: 'present', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'optical_prescription', actual: 'present' }));
};

const verifyMentalHealthAssessment: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.MENTAL_HEALTH) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const assessmentField = getBooleanField(input, ['mental_health_assessment_present']);

  if (assessmentField === true) {
    return pass(makeEvidence({ field: 'mental_health_assessment', actual: 'present' }));
  }

  const notes = getDocumentsByType(input, DocumentType.PHYSICIAN_NOTES)
    .map((doc) => `${doc.textContent ?? ''}`.toLowerCase())
    .join(' ');

  if (/(mental status|psychiatric assessment|risk assessment|depression score)/i.test(notes)) {
    return pass(makeEvidence({ field: 'mental_health_assessment', actual: 'present_in_notes' }));
  }

  return fail(makeEvidence({ field: 'mental_health_assessment', expected: 'present', actual: 'missing' }));
};

const verifyDialysisRecordsIfRenal: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.RENAL) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const dialysisField = getBooleanField(input, ['dialysis_record_present', 'dialysis_notes_present']);

  if (dialysisField === true) {
    return pass(makeEvidence({ field: 'dialysis_records', actual: 'present' }));
  }

  const hasDialysisDoc = input.documents.some((document) => {
    const text = `${document.textContent ?? ''}`.toLowerCase();
    return /dialysis|hemodialysis|peritoneal/i.test(text);
  });

  if (!hasDialysisDoc) {
    return fail(makeEvidence({ field: 'dialysis_records', expected: 'present', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'dialysis_records', actual: 'present' }));
};

const verifyBmiDocumented: RuleLogicFn = (input) => {
  const diagnosisText = getDiagnosisText(input);
  const bmiRelevant = /(obes|diabet|hypertens|metabolic)/i.test(diagnosisText);

  if (!bmiRelevant) {
    return pass(makeEvidence({ field: 'bmi', actual: 'not_applicable' }));
  }

  const bmi = getNumberField(input, ['bmi']);

  if (bmi === null) {
    return fail(makeEvidence({ field: 'bmi', expected: 'documented', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'bmi', actual: `${bmi}` }));
};

const verifyChronologyMakesSense: RuleLogicFn = (input) => {
  const admissionDate = getDateField(input, ['admission_date']) ??
    (typeof input.claim.admissionDate === 'string' ? parseDate(input.claim.admissionDate) : null);
  const dischargeDate = getDateField(input, ['discharge_date']) ??
    (typeof input.claim.dischargeDate === 'string' ? parseDate(input.claim.dischargeDate) : null);

  if (!admissionDate) {
    return incomplete('admission_date_missing', makeEvidence({ field: 'admission_date' }));
  }

  if (dischargeDate && dischargeDate.getTime() < admissionDate.getTime()) {
    return fail(makeEvidence({ field: 'chronology', expected: 'discharge >= admission', actual: 'invalid_sequence' }));
  }

  const procedureDates = getStringListField(input, ['procedure_dates'])
    .map((value) => parseDate(value))
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime());

  if (procedureDates.length > 1) {
    for (let index = 1; index < procedureDates.length; index += 1) {
      const current = procedureDates[index];
      const previous = procedureDates[index - 1];

      if (!current || !previous || current.getTime() < previous.getTime()) {
        return fail(makeEvidence({ field: 'procedure_dates', expected: 'chronological order', actual: 'out_of_order' }));
      }
    }
  }

  return pass(makeEvidence({ field: 'chronology', actual: 'valid' }));
};

const verifySecondaryDiagnosisDocumented: RuleLogicFn = (input) => {
  const secondaryCodes = getStringListField(input, ['secondary_diagnosis_codes', 'secondary_diagnoses']);

  if (secondaryCodes.length === 0) {
    return pass(makeEvidence({ field: 'secondary_diagnosis', actual: 'not_applicable' }));
  }

  const hasSecondaryText = getStringField(input, ['secondary_diagnosis_text', 'secondary_diagnosis']) !== null;

  if (!hasSecondaryText) {
    return fail(makeEvidence({ field: 'secondary_diagnosis', expected: 'documentation for secondary diagnoses', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'secondary_diagnosis', actual: 'documented' }));
};

const verifyClinicalCompletenessScore: RuleLogicFn = (input) => {
  const checks = [
    getPrimaryDiagnosisCode(input) !== null,
    hasProcedureData(input),
    getBooleanField(input, ['physician_signature_present']) === true,
    getBooleanField(input, ['follow_up_plan_present']) === true,
    getStringField(input, ['allergy_status', 'allergies']) !== null,
  ];

  const completed = checks.filter(Boolean).length;
  const score = completed / checks.length;

  if (score < 0.7) {
    return warning(makeEvidence({ field: 'clinical_completeness_score', expected: '>= 0.70', actual: score.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'clinical_completeness_score', actual: score.toFixed(2) }));
};

export const clinicalRuleLogicRegistry: Record<string, RuleLogicFn> = {
  verify_icd_code_valid: verifyIcdCodeValid,
  verify_icd_code_specificity: verifyIcdCodeSpecificity,
  verify_diagnosis_matches_claim_type: verifyDiagnosisMatchesClaimType,
  verify_procedure_matches_diagnosis: verifyProcedureMatchesDiagnosis,
  verify_procedure_code_valid: verifyProcedureCodeValid,
  verify_los_appropriate: verifyLosAppropriate,
  verify_medications_match_diagnosis: verifyMedicationsMatchDiagnosis,
  verify_lab_tests_relevant: verifyLabTestsRelevant,
  verify_no_clinical_contradictions: verifyNoClinicalContradictions,
  verify_age_appropriate_diagnosis: verifyAgeAppropriateDiagnosis,
  verify_gender_appropriate_diagnosis: verifyGenderAppropriateDiagnosis,
  verify_maternity_gestational_age: verifyMaternityGestationalAge,
  verify_vital_signs_documented: verifyVitalSignsDocumented,
  verify_admission_criteria_met_ip: verifyAdmissionCriteriaMetIp,
  verify_follow_up_plan_documented: verifyFollowUpPlanDocumented,
  verify_emergency_triage_documented: verifyEmergencyTriageDocumented,
  verify_allergy_documentation: verifyAllergyDocumentation,
  verify_dental_chart_if_dental: verifyDentalChartIfDental,
  verify_optical_prescription_if_optical: verifyOpticalPrescriptionIfOptical,
  verify_mental_health_assessment: verifyMentalHealthAssessment,
  verify_dialysis_records_if_renal: verifyDialysisRecordsIfRenal,
  verify_bmi_documented: verifyBmiDocumented,
  verify_chronology_makes_sense: verifyChronologyMakesSense,
  verify_secondary_diagnosis_documented: verifySecondaryDiagnosisDocumented,
  verify_clinical_completeness_score: verifyClinicalCompletenessScore,
};

export const clinicalRuleIds = {
  'CLN-001': 'verify_icd_code_valid',
  'CLN-002': 'verify_icd_code_specificity',
  'CLN-003': 'verify_diagnosis_matches_claim_type',
  'CLN-004': 'verify_procedure_matches_diagnosis',
  'CLN-005': 'verify_procedure_code_valid',
  'CLN-006': 'verify_los_appropriate',
  'CLN-007': 'verify_medications_match_diagnosis',
  'CLN-008': 'verify_lab_tests_relevant',
  'CLN-009': 'verify_no_clinical_contradictions',
  'CLN-010': 'verify_age_appropriate_diagnosis',
  'CLN-011': 'verify_gender_appropriate_diagnosis',
  'CLN-012': 'verify_maternity_gestational_age',
  'CLN-013': 'verify_vital_signs_documented',
  'CLN-014': 'verify_admission_criteria_met_ip',
  'CLN-015': 'verify_follow_up_plan_documented',
  'CLN-016': 'verify_emergency_triage_documented',
  'CLN-017': 'verify_allergy_documentation',
  'CLN-018': 'verify_dental_chart_if_dental',
  'CLN-019': 'verify_optical_prescription_if_optical',
  'CLN-020': 'verify_mental_health_assessment',
  'CLN-021': 'verify_dialysis_records_if_renal',
  'CLN-022': 'verify_bmi_documented',
  'CLN-023': 'verify_chronology_makes_sense',
  'CLN-024': 'verify_secondary_diagnosis_documented',
  'CLN-025': 'verify_clinical_completeness_score',
} as const;


