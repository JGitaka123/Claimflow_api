import { ClaimType, DocumentType } from '@claimflow/shared';
import type { RuleLogicFn } from '../types.js';
import {
  datesWithinDays,
  extractDocumentText,
  fail,
  getBooleanField,
  getDateField,
  getDocumentBooleanFlag,
  getDocumentQualityScore,
  getDocumentsByType,
  getStringField,
  hasDocumentType,
  hasLineCategory,
  incomplete,
  makeEvidence,
  pass,
  requiredClaimFormType,
  warning,
} from './utils.js';

function isSurgicalClaim(input: Parameters<RuleLogicFn>[0]): boolean {
  return (
    input.claim.claimType === ClaimType.SURGICAL ||
    hasLineCategory(input, {
      keywords: ['surgery', 'operative', 'operation', 'procedure'],
      codePrefixes: ['SURG', 'PROC'],
      categoryKeys: ['category', 'serviceCategory'],
    })
  );
}

function isReferredClaim(input: Parameters<RuleLogicFn>[0]): boolean {
  return (
    getBooleanField(input, ['referred', 'is_referred']) === true ||
    hasDocumentType(input, DocumentType.REFERRAL_LETTER)
  );
}

function hasOtherSupportingWithKeyword(input: Parameters<RuleLogicFn>[0], keyword: RegExp): boolean {
  return getDocumentsByType(input, DocumentType.OTHER_SUPPORTING).some((document) => {
    const kind = typeof document.metadata?.document_kind === 'string' ? document.metadata.document_kind : '';
    const text = extractDocumentText(document);
    return keyword.test(kind) || keyword.test(text);
  });
}

const verifyClaimFormPresent: RuleLogicFn = (input) => {
  const requiredType = requiredClaimFormType(input.claim.claimType);

  if (!hasDocumentType(input, requiredType)) {
    return fail(
      makeEvidence({ field: 'claim_form', expected: requiredType, actual: 'missing' }),
    );
  }

  return pass(makeEvidence({ field: 'claim_form', actual: requiredType }));
};

const verifyClaimFormTypeMatches: RuleLogicFn = (input) => {
  const claimFormTypes = [
    DocumentType.SHA_CLAIM_FORM_OP,
    DocumentType.SHA_CLAIM_FORM_IP,
    DocumentType.SHA_CLAIM_FORM_MATERNITY,
  ] as const;

  const presentForms = input.documents.filter((document) => claimFormTypes.includes(document.docType as (typeof claimFormTypes)[number]));

  if (presentForms.length === 0) {
    return fail(
      makeEvidence({ field: 'claim_form_type', expected: requiredClaimFormType(input.claim.claimType), actual: 'missing' }),
    );
  }

  const requiredType = requiredClaimFormType(input.claim.claimType);
  const hasRequired = presentForms.some((document) => document.docType === requiredType);

  if (!hasRequired) {
    const actualTypes = presentForms.map((document) => document.docType).join('|');
    return fail(
      makeEvidence({ field: 'claim_form_type', expected: requiredType, actual: actualTypes }),
    );
  }

  return pass(makeEvidence({ field: 'claim_form_type', actual: requiredType }));
};

const verifyPhysicianSignaturePresent: RuleLogicFn = (input) => {
  const present = getBooleanField(input, ['physician_signature_present', 'doctor_signature_present']);

  if (present !== true) {
    return fail(
      makeEvidence({ field: 'physician_signature_present', expected: 'true', actual: `${present ?? 'missing'}` }),
    );
  }

  return pass(makeEvidence({ field: 'physician_signature_present', actual: 'true' }));
};

const verifyPhysicianStampPresent: RuleLogicFn = (input) => {
  const present = getBooleanField(input, ['physician_stamp_present', 'doctor_stamp_present']);

  if (present !== true) {
    return fail(
      makeEvidence({ field: 'physician_stamp_present', expected: 'true', actual: `${present ?? 'missing'}` }),
    );
  }

  return pass(makeEvidence({ field: 'physician_stamp_present', actual: 'true' }));
};

const verifyClaimFormDatePresent: RuleLogicFn = (input) => {
  const claimFormDate = getDateField(input, ['claim_form_date', 'visit_date']);

  if (!claimFormDate) {
    return fail(
      makeEvidence({ field: 'claim_form_date', expected: 'parseable date', actual: 'missing_or_invalid' }),
    );
  }

  return pass(makeEvidence({ field: 'claim_form_date', actual: claimFormDate.toISOString().slice(0, 10) }));
};

const verifyClaimFormDateMatchesAdmission: RuleLogicFn = (input) => {
  const claimFormDate = getDateField(input, ['claim_form_date', 'visit_date']);
  const admissionDate = getDateField(input, ['admission_date']) ??
    (typeof input.claim.admissionDate === 'string' ? new Date(`${input.claim.admissionDate}T00:00:00.000Z`) : null);

  if (!claimFormDate || !admissionDate || Number.isNaN(admissionDate.getTime())) {
    return incomplete('date_data_unavailable', makeEvidence({ field: 'claim_form_date' }));
  }

  if (!datesWithinDays(claimFormDate, admissionDate, 1)) {
    return fail(
      makeEvidence({
        field: 'claim_form_date',
        expected: `within 1 day of ${admissionDate.toISOString().slice(0, 10)}`,
        actual: claimFormDate.toISOString().slice(0, 10),
      }),
    );
  }

  return pass(
    makeEvidence({
      field: 'claim_form_date',
      expected: `within 1 day of ${admissionDate.toISOString().slice(0, 10)}`,
      actual: claimFormDate.toISOString().slice(0, 10),
    }),
  );
};

const verifyDischargeSummaryPresentIp: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.INPATIENT) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  if (!hasDocumentType(input, DocumentType.DISCHARGE_SUMMARY)) {
    return fail(
      makeEvidence({ field: 'documents', expected: DocumentType.DISCHARGE_SUMMARY, actual: 'missing' }),
    );
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.DISCHARGE_SUMMARY }));
};

const verifyDischargeSummarySigned: RuleLogicFn = (input) => {
  const dischargeDocs = getDocumentsByType(input, DocumentType.DISCHARGE_SUMMARY);

  if (dischargeDocs.length === 0) {
    return pass(makeEvidence({ field: 'discharge_summary', actual: 'not_applicable' }));
  }

  let unknownSeen = false;

  for (const document of dischargeDocs) {
    const signed = getDocumentBooleanFlag(document, ['signature_present', 'physician_signature_present']);

    if (signed === true) {
      return pass(makeEvidence({ field: 'discharge_summary_signature', actual: 'true', documentId: document.id }));
    }

    if (signed === null) {
      unknownSeen = true;
    }
  }

  if (unknownSeen) {
    return incomplete('discharge_signature_unavailable', makeEvidence({ field: 'discharge_summary_signature' }));
  }

  return fail(makeEvidence({ field: 'discharge_summary_signature', expected: 'true', actual: 'false' }));
};

const verifyPhysicianNotesPresent: RuleLogicFn = (input) => {
  if (!hasDocumentType(input, DocumentType.PHYSICIAN_NOTES)) {
    return fail(
      makeEvidence({ field: 'documents', expected: DocumentType.PHYSICIAN_NOTES, actual: 'missing' }),
    );
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.PHYSICIAN_NOTES }));
};

const verifyDiagnosisDocumentedInNotes: RuleLogicFn = (input) => {
  const notesDocs = getDocumentsByType(input, DocumentType.PHYSICIAN_NOTES);

  if (notesDocs.length === 0) {
    return incomplete('physician_notes_missing', makeEvidence({ field: 'physician_notes_text' }));
  }

  const text = notesDocs.map((doc) => extractDocumentText(doc)).join(' ').toLowerCase();

  if (text.trim().length === 0) {
    return incomplete('physician_notes_ocr_unavailable', makeEvidence({ field: 'physician_notes_text' }));
  }

  if (!/diagnos/i.test(text)) {
    return fail(makeEvidence({ field: 'physician_notes_text', expected: 'contains diagnosis', actual: 'not_found' }));
  }

  return pass(makeEvidence({ field: 'physician_notes_text', actual: 'diagnosis_found' }));
};

const verifyTreatmentPlanDocumented: RuleLogicFn = (input) => {
  const notesDocs = getDocumentsByType(input, DocumentType.PHYSICIAN_NOTES);

  if (notesDocs.length === 0) {
    return incomplete('physician_notes_missing', makeEvidence({ field: 'physician_notes_text' }));
  }

  const text = notesDocs.map((doc) => extractDocumentText(doc)).join(' ').toLowerCase();

  if (text.trim().length === 0) {
    return incomplete('physician_notes_ocr_unavailable', makeEvidence({ field: 'physician_notes_text' }));
  }

  if (!/(treatment\s*plan|management\s*plan|procedure|therapy|medication\s*plan)/i.test(text)) {
    return fail(makeEvidence({ field: 'physician_notes_text', expected: 'contains treatment plan', actual: 'not_found' }));
  }

  return pass(makeEvidence({ field: 'physician_notes_text', actual: 'treatment_plan_found' }));
};

const verifyLabResultsPresentIfClaimed: RuleLogicFn = (input) => {
  const labClaimed = hasLineCategory(input, {
    keywords: ['lab', 'laboratory', 'pathology', 'test'],
    codePrefixes: ['lab'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!labClaimed) {
    return pass(makeEvidence({ field: 'claim_lines', actual: 'no_lab_lines' }));
  }

  if (!hasDocumentType(input, DocumentType.LAB_RESULTS)) {
    return fail(
      makeEvidence({ field: 'documents', expected: DocumentType.LAB_RESULTS, actual: 'missing' }),
    );
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.LAB_RESULTS }));
};

const verifyLabResultsFromAccredited: RuleLogicFn = (input) => {
  const labDocs = getDocumentsByType(input, DocumentType.LAB_RESULTS);

  if (labDocs.length === 0) {
    return pass(makeEvidence({ field: 'lab_results', actual: 'not_applicable' }));
  }

  let unknownSeen = false;

  for (const document of labDocs) {
    const headerPresent = getDocumentBooleanFlag(document, ['facility_header_present', 'accredited_header_present']);

    if (headerPresent === true) {
      return pass(makeEvidence({ field: 'facility_header_present', actual: 'true', documentId: document.id }));
    }

    if (headerPresent === null) {
      unknownSeen = true;
    }
  }

  if (unknownSeen) {
    return incomplete('lab_header_unavailable', makeEvidence({ field: 'facility_header_present' }));
  }

  return fail(
    makeEvidence({ field: 'facility_header_present', expected: 'true', actual: 'false' }),
  );
};

const verifyPrescriptionPresentIfPharmacy: RuleLogicFn = (input) => {
  const pharmacyClaimed = hasLineCategory(input, {
    keywords: ['pharmacy', 'drug', 'medicine', 'medication'],
    codePrefixes: ['rx', 'pharm'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!pharmacyClaimed) {
    return pass(makeEvidence({ field: 'claim_lines', actual: 'no_pharmacy_lines' }));
  }

  if (!hasDocumentType(input, DocumentType.PRESCRIPTION)) {
    return fail(
      makeEvidence({ field: 'documents', expected: DocumentType.PRESCRIPTION, actual: 'missing' }),
    );
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.PRESCRIPTION }));
};

const verifyPrescriptionSigned: RuleLogicFn = (input) => {
  const prescriptionDocs = getDocumentsByType(input, DocumentType.PRESCRIPTION);

  if (prescriptionDocs.length === 0) {
    return pass(makeEvidence({ field: 'prescription', actual: 'not_applicable' }));
  }

  let unknownSeen = false;

  for (const document of prescriptionDocs) {
    const signed = getDocumentBooleanFlag(document, ['signature_present', 'prescriber_signature_present']);

    if (signed === true) {
      return pass(makeEvidence({ field: 'prescription_signature', actual: 'true', documentId: document.id }));
    }

    if (signed === null) {
      unknownSeen = true;
    }
  }

  if (unknownSeen) {
    return incomplete('prescription_signature_unavailable', makeEvidence({ field: 'prescription_signature' }));
  }

  return fail(makeEvidence({ field: 'prescription_signature', expected: 'true', actual: 'false' }));
};

const verifyReferralLetterIfReferred: RuleLogicFn = (input) => {
  if (!isReferredClaim(input)) {
    return pass(makeEvidence({ field: 'referred', actual: 'false' }));
  }

  if (!hasDocumentType(input, DocumentType.REFERRAL_LETTER)) {
    return fail(makeEvidence({ field: 'documents', expected: DocumentType.REFERRAL_LETTER, actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.REFERRAL_LETTER }));
};

const verifyReferralLetterValid: RuleLogicFn = (input) => {
  if (!isReferredClaim(input)) {
    return pass(makeEvidence({ field: 'referral_letter', actual: 'not_applicable' }));
  }

  const referralDocs = getDocumentsByType(input, DocumentType.REFERRAL_LETTER);

  if (referralDocs.length === 0) {
    return fail(makeEvidence({ field: 'referral_letter', expected: 'present', actual: 'missing' }));
  }

  const recognizedFlag = getBooleanField(input, ['referral_facility_recognized']);

  if (recognizedFlag === true) {
    return pass(makeEvidence({ field: 'referral_facility_recognized', actual: 'true' }));
  }

  if (recognizedFlag === false) {
    return fail(makeEvidence({ field: 'referral_facility_recognized', expected: 'true', actual: 'false' }));
  }

  for (const document of referralDocs) {
    const recognized = getDocumentBooleanFlag(document, ['referring_facility_recognized', 'facility_recognized']);

    if (recognized === true) {
      return pass(makeEvidence({ field: 'referral_facility_recognized', actual: 'true', documentId: document.id }));
    }

    if (recognized === false) {
      return fail(makeEvidence({ field: 'referral_facility_recognized', expected: 'true', actual: 'false' }));
    }
  }

  return incomplete('referral_validation_unavailable', makeEvidence({ field: 'referral_facility_recognized' }));
};

const verifyConsentFormIfSurgical: RuleLogicFn = (input) => {
  if (!isSurgicalClaim(input)) {
    return pass(makeEvidence({ field: 'surgical_claim', actual: 'false' }));
  }

  if (!hasDocumentType(input, DocumentType.CONSENT_FORM)) {
    return fail(makeEvidence({ field: 'documents', expected: DocumentType.CONSENT_FORM, actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.CONSENT_FORM }));
};

const verifyConsentFormSignedByPatient: RuleLogicFn = (input) => {
  const consentDocs = getDocumentsByType(input, DocumentType.CONSENT_FORM);

  if (consentDocs.length === 0) {
    if (!isSurgicalClaim(input)) {
      return pass(makeEvidence({ field: 'consent_form', actual: 'not_applicable' }));
    }

    return fail(makeEvidence({ field: 'consent_form', expected: 'present', actual: 'missing' }));
  }

  let unknownSeen = false;

  for (const document of consentDocs) {
    const signed = getDocumentBooleanFlag(document, ['patient_signature_present', 'signature_present']);

    if (signed === true) {
      return pass(makeEvidence({ field: 'patient_signature_present', actual: 'true', documentId: document.id }));
    }

    if (signed === null) {
      unknownSeen = true;
    }
  }

  if (unknownSeen) {
    return incomplete('consent_signature_unavailable', makeEvidence({ field: 'patient_signature_present' }));
  }

  return fail(makeEvidence({ field: 'patient_signature_present', expected: 'true', actual: 'false' }));
};

const verifyPreauthFormIfRequired: RuleLogicFn = (input) => {
  const preauthRequired = getBooleanField(input, ['preauth_required', 'preauthorization_required']) === true ||
    (typeof input.claim.preauthNumber === 'string' && input.claim.preauthNumber.trim().length > 0) ||
    (input.claim.lines ?? []).some((line) => typeof line.preauthNumber === 'string' && line.preauthNumber.trim().length > 0);

  if (!preauthRequired) {
    return pass(makeEvidence({ field: 'preauth_required', actual: 'false' }));
  }

  if (!hasDocumentType(input, DocumentType.PREAUTH_FORM)) {
    return fail(makeEvidence({ field: 'documents', expected: DocumentType.PREAUTH_FORM, actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.PREAUTH_FORM }));
};

const verifyOperativeNoteIfSurgical: RuleLogicFn = (input) => {
  if (!isSurgicalClaim(input)) {
    return pass(makeEvidence({ field: 'surgical_claim', actual: 'false' }));
  }

  if (!hasDocumentType(input, DocumentType.OPERATIVE_NOTE)) {
    return fail(makeEvidence({ field: 'documents', expected: DocumentType.OPERATIVE_NOTE, actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.OPERATIVE_NOTE }));
};

const verifyAnesthesiaRecordIfApplicable: RuleLogicFn = (input) => {
  const anesthesiaRequired = getBooleanField(input, ['anesthesia_required']) === true ||
    hasLineCategory(input, {
      keywords: ['anesthesia', 'general anesthesia', 'ga'],
      codePrefixes: ['ANES'],
      categoryKeys: ['category', 'serviceCategory'],
    });

  if (!anesthesiaRequired) {
    return pass(makeEvidence({ field: 'anesthesia_record', actual: 'not_applicable' }));
  }

  const hasAnesthesiaRecord = hasOtherSupportingWithKeyword(input, /anesthesia|anaesthesia/i);

  if (!hasAnesthesiaRecord) {
    return fail(makeEvidence({ field: 'anesthesia_record', expected: 'present', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'anesthesia_record', actual: 'present' }));
};

const verifyNursingNotesPresentIp: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.INPATIENT) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const nursingFlag = getBooleanField(input, ['nursing_notes_present']);
  const hasNursingDoc = hasOtherSupportingWithKeyword(input, /nursing\s*notes?/i);

  if (nursingFlag === true || hasNursingDoc) {
    return pass(makeEvidence({ field: 'nursing_notes', actual: 'present' }));
  }

  return warning(makeEvidence({ field: 'nursing_notes', expected: 'recommended for inpatient', actual: 'missing' }));
};

const verifyRadiologyReportIfClaimed: RuleLogicFn = (input) => {
  const radiologyClaimed = hasLineCategory(input, {
    keywords: ['radiology', 'imaging', 'xray', 'mri', 'ct scan', 'ultrasound'],
    codePrefixes: ['RAD', 'IMG', 'MRI', 'CT'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!radiologyClaimed) {
    return pass(makeEvidence({ field: 'radiology_claimed', actual: 'false' }));
  }

  if (!hasDocumentType(input, DocumentType.RADIOLOGY_REPORT)) {
    return fail(makeEvidence({ field: 'documents', expected: DocumentType.RADIOLOGY_REPORT, actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'documents', actual: DocumentType.RADIOLOGY_REPORT }));
};

const verifyAllPagesLegible: RuleLogicFn = (input) => {
  const qualityScores = input.documents
    .map((document) => getDocumentQualityScore(document))
    .filter((score): score is number => score !== null);

  if (qualityScores.length === 0) {
    return incomplete('image_quality_unavailable', makeEvidence({ field: 'image_quality_score' }));
  }

  const minScore = Math.min(...qualityScores);

  if (minScore < 0.5) {
    return warning(makeEvidence({ field: 'image_quality_score', expected: '>= 0.50', actual: minScore.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'image_quality_score', actual: minScore.toFixed(2) }));
};

const verifyNoCriticalFieldsMissing: RuleLogicFn = (input) => {
  const missing: string[] = [];

  if (!(input.claim.patientShaId ?? getStringField(input, ['patient_sha_id']))) {
    missing.push('patient_sha_id');
  }

  if (!(input.claim.patientName ?? getStringField(input, ['patient_name']))) {
    missing.push('patient_name');
  }

  if (!getDateField(input, ['claim_form_date', 'visit_date'])) {
    missing.push('claim_form_date');
  }

  if (!getBooleanField(input, ['physician_signature_present', 'doctor_signature_present'])) {
    missing.push('physician_signature_present');
  }

  if (missing.length > 0) {
    return fail(makeEvidence({ field: 'critical_fields', expected: 'all mandatory fields present', actual: missing.join(',') }));
  }

  return pass(makeEvidence({ field: 'critical_fields', actual: 'complete' }));
};

const verifyDocumentDatesConsistent: RuleLogicFn = (input) => {
  const parsedDates = [...input.extractedFields.entries()]
    .filter(([key]) => /date/i.test(key))
    .map(([, value]) => (typeof value.value === 'string' ? value.value : null))
    .filter((value): value is string => value !== null)
    .map((value) => {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value !== null);

  if (parsedDates.length < 2) {
    return incomplete('insufficient_document_dates', makeEvidence({ field: 'document_dates' }));
  }

  const times = parsedDates.map((date) => date.getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const spreadDays = (maxTime - minTime) / (24 * 60 * 60 * 1000);

  if (spreadDays > 180) {
    return fail(makeEvidence({ field: 'document_dates', expected: 'date spread <= 180 days', actual: `${spreadDays.toFixed(1)} days` }));
  }

  return pass(makeEvidence({ field: 'document_dates', actual: `${spreadDays.toFixed(1)} days` }));
};

const verifyPatientNameOnAllDocs: RuleLogicFn = (input) => {
  const patientName = (input.claim.patientName ?? getStringField(input, ['patient_name']) ?? '').toLowerCase().trim();

  if (patientName.length === 0) {
    return incomplete('patient_name_missing', makeEvidence({ field: 'patient_name' }));
  }

  const clinicalDocTypes = [
    DocumentType.DISCHARGE_SUMMARY,
    DocumentType.PHYSICIAN_NOTES,
    DocumentType.LAB_RESULTS,
    DocumentType.PRESCRIPTION,
    DocumentType.RADIOLOGY_REPORT,
    DocumentType.OPERATIVE_NOTE,
  ];

  for (const document of input.documents.filter((item) => clinicalDocTypes.includes(item.docType))) {
    const nameFlag = getDocumentBooleanFlag(document, ['patient_name_present']);

    if (nameFlag === true) {
      continue;
    }

    const text = extractDocumentText(document).toLowerCase();

    if (!text.includes(patientName)) {
      return fail(makeEvidence({ field: 'patient_name_on_document', expected: patientName, actual: `missing in ${document.id}`, documentId: document.id }));
    }
  }

  return pass(makeEvidence({ field: 'patient_name_on_document', actual: 'present_on_all_clinical_docs' }));
};

const verifyFacilityHeaderOnClinicalDocs: RuleLogicFn = (input) => {
  const clinicalDocTypes = [
    DocumentType.DISCHARGE_SUMMARY,
    DocumentType.PHYSICIAN_NOTES,
    DocumentType.LAB_RESULTS,
    DocumentType.RADIOLOGY_REPORT,
    DocumentType.OPERATIVE_NOTE,
  ];

  for (const document of input.documents.filter((item) => clinicalDocTypes.includes(item.docType))) {
    const headerFlag = getDocumentBooleanFlag(document, ['facility_header_present']);

    if (headerFlag === true) {
      continue;
    }

    return warning(makeEvidence({ field: 'facility_header_present', expected: 'true', actual: `missing in ${document.id}`, documentId: document.id }));
  }

  return pass(makeEvidence({ field: 'facility_header_present', actual: 'present_or_not_required' }));
};

const verifyMaternityDeliveryRecord: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.MATERNITY) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const hasDeliveryRecord = hasOtherSupportingWithKeyword(input, /delivery\s*record|partograph|labour/i);

  if (!hasDeliveryRecord) {
    return fail(makeEvidence({ field: 'delivery_record', expected: 'present for maternity claim', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'delivery_record', actual: 'present' }));
};

const verifyBabyBirthNotification: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.MATERNITY) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const birthNotificationFlag = getBooleanField(input, ['birth_notification_present']) === true;
  const hasBirthNotificationDoc = hasOtherSupportingWithKeyword(input, /birth\s*notification|live\s*birth/i);

  if (!birthNotificationFlag && !hasBirthNotificationDoc) {
    return fail(makeEvidence({ field: 'birth_notification', expected: 'present', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'birth_notification', actual: 'present' }));
};

const verifyAncCardIfMaternity: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.MATERNITY) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const ancCardPresent = getBooleanField(input, ['anc_card_present']) === true ||
    hasOtherSupportingWithKeyword(input, /anc\s*card|antenatal/i);

  if (!ancCardPresent) {
    return warning(makeEvidence({ field: 'anc_card', expected: 'recommended for maternity claims', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'anc_card', actual: 'present' }));
};

const verifyDocumentNotExpired: RuleLogicFn = (input) => {
  const admissionDate = getDateField(input, ['admission_date']) ??
    (typeof input.claim.admissionDate === 'string' ? new Date(`${input.claim.admissionDate}T00:00:00.000Z`) : null);

  if (!admissionDate || Number.isNaN(admissionDate.getTime())) {
    return incomplete('admission_date_missing', makeEvidence({ field: 'admission_date' }));
  }

  const documentDate = getDateField(input, ['claim_form_date', 'document_date']);

  if (!documentDate) {
    return incomplete('document_date_missing', makeEvidence({ field: 'document_date' }));
  }

  const daysDelta = Math.abs((admissionDate.getTime() - documentDate.getTime()) / (24 * 60 * 60 * 1000));

  if (daysDelta > 365) {
    return fail(makeEvidence({ field: 'document_date', expected: '<= 365 days from admission', actual: `${daysDelta.toFixed(0)} days` }));
  }

  return pass(makeEvidence({ field: 'document_date', actual: `${daysDelta.toFixed(0)} days` }));
};

const verifyNoDuplicateDocuments: RuleLogicFn = (input) => {
  const signatureCounts = new Map<string, number>();

  for (const document of input.documents) {
    const signature = `${document.docType}|${document.pageCount ?? 0}|${extractDocumentText(document).slice(0, 120)}`.toLowerCase();
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }

  for (const count of signatureCounts.values()) {
    if (count > 1) {
      return warning(makeEvidence({ field: 'duplicate_documents', expected: 'no duplicates', actual: `${count} copies detected` }));
    }
  }

  return pass(makeEvidence({ field: 'duplicate_documents', actual: 'none_detected' }));
};

const verifyDocumentCompletenessScore: RuleLogicFn = (input) => {
  const checks = [
    hasDocumentType(input, requiredClaimFormType(input.claim.claimType)),
    hasDocumentType(input, DocumentType.PHYSICIAN_NOTES),
    getBooleanField(input, ['physician_signature_present']) === true,
    getDateField(input, ['claim_form_date']) !== null,
    (input.documents.length > 0),
  ];

  const score = checks.filter(Boolean).length / checks.length;

  if (score < 0.75) {
    return warning(makeEvidence({ field: 'documentation_completeness_score', expected: '>= 0.75', actual: score.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'documentation_completeness_score', actual: score.toFixed(2) }));
};

export const documentationRuleLogicRegistry: Record<string, RuleLogicFn> = {
  verify_claim_form_present: verifyClaimFormPresent,
  verify_claim_form_type_matches: verifyClaimFormTypeMatches,
  verify_physician_signature_present: verifyPhysicianSignaturePresent,
  verify_physician_stamp_present: verifyPhysicianStampPresent,
  verify_claim_form_date_present: verifyClaimFormDatePresent,
  verify_claim_form_date_matches_admission: verifyClaimFormDateMatchesAdmission,
  verify_discharge_summary_present_ip: verifyDischargeSummaryPresentIp,
  verify_discharge_summary_signed: verifyDischargeSummarySigned,
  verify_physician_notes_present: verifyPhysicianNotesPresent,
  verify_diagnosis_documented_in_notes: verifyDiagnosisDocumentedInNotes,
  verify_treatment_plan_documented: verifyTreatmentPlanDocumented,
  verify_lab_results_present_if_claimed: verifyLabResultsPresentIfClaimed,
  verify_lab_results_from_accredited: verifyLabResultsFromAccredited,
  verify_prescription_present_if_pharmacy: verifyPrescriptionPresentIfPharmacy,
  verify_prescription_signed: verifyPrescriptionSigned,
  verify_referral_letter_if_referred: verifyReferralLetterIfReferred,
  verify_referral_letter_valid: verifyReferralLetterValid,
  verify_consent_form_if_surgical: verifyConsentFormIfSurgical,
  verify_consent_form_signed_by_patient: verifyConsentFormSignedByPatient,
  verify_preauth_form_if_required: verifyPreauthFormIfRequired,
  verify_operative_note_if_surgical: verifyOperativeNoteIfSurgical,
  verify_anesthesia_record_if_applicable: verifyAnesthesiaRecordIfApplicable,
  verify_nursing_notes_present_ip: verifyNursingNotesPresentIp,
  verify_radiology_report_if_claimed: verifyRadiologyReportIfClaimed,
  verify_all_pages_legible: verifyAllPagesLegible,
  verify_no_critical_fields_missing: verifyNoCriticalFieldsMissing,
  verify_document_dates_consistent: verifyDocumentDatesConsistent,
  verify_patient_name_on_all_docs: verifyPatientNameOnAllDocs,
  verify_facility_header_on_clinical_docs: verifyFacilityHeaderOnClinicalDocs,
  verify_maternity_delivery_record: verifyMaternityDeliveryRecord,
  verify_baby_birth_notification: verifyBabyBirthNotification,
  verify_anc_card_if_maternity: verifyAncCardIfMaternity,
  verify_document_not_expired: verifyDocumentNotExpired,
  verify_no_duplicate_documents: verifyNoDuplicateDocuments,
  verify_document_completeness_score: verifyDocumentCompletenessScore,
};

export const documentationRuleIds = {
  'DOC-001': 'verify_claim_form_present',
  'DOC-002': 'verify_claim_form_type_matches',
  'DOC-003': 'verify_physician_signature_present',
  'DOC-004': 'verify_physician_stamp_present',
  'DOC-005': 'verify_claim_form_date_present',
  'DOC-006': 'verify_claim_form_date_matches_admission',
  'DOC-007': 'verify_discharge_summary_present_ip',
  'DOC-008': 'verify_discharge_summary_signed',
  'DOC-009': 'verify_physician_notes_present',
  'DOC-010': 'verify_diagnosis_documented_in_notes',
  'DOC-011': 'verify_treatment_plan_documented',
  'DOC-012': 'verify_lab_results_present_if_claimed',
  'DOC-013': 'verify_lab_results_from_accredited',
  'DOC-014': 'verify_prescription_present_if_pharmacy',
  'DOC-015': 'verify_prescription_signed',
  'DOC-016': 'verify_referral_letter_if_referred',
  'DOC-017': 'verify_referral_letter_valid',
  'DOC-018': 'verify_consent_form_if_surgical',
  'DOC-019': 'verify_consent_form_signed_by_patient',
  'DOC-020': 'verify_preauth_form_if_required',
  'DOC-021': 'verify_operative_note_if_surgical',
  'DOC-022': 'verify_anesthesia_record_if_applicable',
  'DOC-023': 'verify_nursing_notes_present_ip',
  'DOC-024': 'verify_radiology_report_if_claimed',
  'DOC-025': 'verify_all_pages_legible',
  'DOC-026': 'verify_no_critical_fields_missing',
  'DOC-027': 'verify_document_dates_consistent',
  'DOC-028': 'verify_patient_name_on_all_docs',
  'DOC-029': 'verify_facility_header_on_clinical_docs',
  'DOC-030': 'verify_maternity_delivery_record',
  'DOC-031': 'verify_baby_birth_notification',
  'DOC-032': 'verify_anc_card_if_maternity',
  'DOC-033': 'verify_document_not_expired',
  'DOC-034': 'verify_no_duplicate_documents',
  'DOC-035': 'verify_document_completeness_score',
} as const;

