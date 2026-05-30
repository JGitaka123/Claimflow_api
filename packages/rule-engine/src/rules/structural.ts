import type { RuleLogicFn } from '../types.js';
import {
  fail,
  getBooleanField,
  getDateField,
  getField,
  getStringField,
  incomplete,
  makeEvidence,
  pass,
  sumClaimLineTotals,
  warning,
} from './utils.js';

const verifyClaimHasMinimumOneLine: RuleLogicFn = (input) => {
  const lineCount = input.claim.lines?.length ?? 0;

  if (lineCount < 1) {
    return fail(makeEvidence({ field: 'claim_lines', expected: '>= 1 line item', actual: '0' }));
  }

  return pass(makeEvidence({ field: 'claim_lines', actual: `${lineCount}` }));
};

const verifyClaimHasDocuments: RuleLogicFn = (input) => {
  const count = input.documents.length;

  if (count < 1) {
    return fail(makeEvidence({ field: 'documents', expected: '>= 1 document', actual: '0' }));
  }

  return pass(makeEvidence({ field: 'documents', actual: `${count}` }));
};

const verifyAllRequiredFieldsPresent: RuleLogicFn = (input) => {
  const requiredChecks: Array<{ field: string; present: boolean }> = [
    { field: 'claim_type', present: typeof input.claim.claimType === 'string' },
    { field: 'facility_id', present: typeof input.claim.facilityId === 'string' && input.claim.facilityId.length > 0 },
    { field: 'admission_date', present: typeof input.claim.admissionDate === 'string' && input.claim.admissionDate.length > 0 },
    { field: 'patient_sha_id', present: typeof input.claim.patientShaId === 'string' && input.claim.patientShaId.length > 0 },
  ];

  const missing = requiredChecks.filter((item) => !item.present);

  if (missing.length > 0) {
    return fail(makeEvidence({ field: 'required_fields', expected: 'all mandatory fields present', actual: missing.map((item) => item.field).join(',') }));
  }

  return pass(makeEvidence({ field: 'required_fields', actual: 'complete' }));
};

const verifyDatesLogicallyConsistent: RuleLogicFn = (input) => {
  const admissionDate = getDateField(input, ['admission_date']) ??
    (typeof input.claim.admissionDate === 'string' ? new Date(`${input.claim.admissionDate}T00:00:00.000Z`) : null);
  const dischargeDate = getDateField(input, ['discharge_date']) ??
    (typeof input.claim.dischargeDate === 'string' ? new Date(`${input.claim.dischargeDate}T00:00:00.000Z`) : null);

  if (!admissionDate || Number.isNaN(admissionDate.getTime())) {
    return fail(makeEvidence({ field: 'admission_date', expected: 'valid date', actual: 'missing_or_invalid' }));
  }

  if (dischargeDate && !Number.isNaN(dischargeDate.getTime()) && dischargeDate.getTime() < admissionDate.getTime()) {
    return fail(makeEvidence({ field: 'discharge_date', expected: '>= admission_date', actual: dischargeDate.toISOString().slice(0, 10) }));
  }

  const serviceDate = getDateField(input, ['service_date']);

  if (serviceDate && dischargeDate && serviceDate.getTime() > dischargeDate.getTime()) {
    return fail(makeEvidence({ field: 'service_date', expected: '<= discharge_date', actual: serviceDate.toISOString().slice(0, 10) }));
  }

  return pass(makeEvidence({ field: 'date_consistency', actual: 'valid' }));
};

const verifyLineItemNumbering: RuleLogicFn = (input) => {
  const lines = (input.claim.lines ?? []).slice().sort((left, right) => left.lineNumber - right.lineNumber);

  for (let index = 0; index < lines.length; index += 1) {
    const expected = index + 1;
    const line = lines[index];

    if (!line) {
      continue;
    }

    if (line.lineNumber !== expected) {
      return fail(makeEvidence({ field: 'line_number', expected: `line ${expected}`, actual: `${line.lineNumber}` }));
    }
  }

  return pass(makeEvidence({ field: 'line_number', actual: 'sequential' }));
};

const verifyClaimNotDuplicate: RuleLogicFn = (input) => {
  const duplicateFlag = getBooleanField(input, ['duplicate_claim_detected', 'is_duplicate_claim']);

  if (duplicateFlag === true) {
    return fail(makeEvidence({ field: 'dedup_hash', expected: 'unique claim', actual: 'duplicate_flagged' }));
  }

  if (typeof input.claim.dedupHash !== 'string' || input.claim.dedupHash.trim().length === 0) {
    return incomplete('dedup_hash_missing', makeEvidence({ field: 'dedup_hash' }));
  }

  return pass(makeEvidence({ field: 'dedup_hash', actual: input.claim.dedupHash }));
};

const verifyExtractionCompleteness: RuleLogicFn = (input) => {
  const fields = [...input.extractedFields.values()];

  if (fields.length === 0) {
    return fail(makeEvidence({ field: 'extracted_fields', expected: '>= 1 extracted field', actual: '0' }));
  }

  const confidenceValues = fields
    .map((field) => field.confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (confidenceValues.length === 0) {
    return incomplete('extraction_confidence_missing', makeEvidence({ field: 'extracted_fields' }));
  }

  const averageConfidence = confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length;

  if (averageConfidence < 0.7) {
    return fail(makeEvidence({ field: 'extraction_confidence', expected: '>= 0.70', actual: averageConfidence.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'extraction_confidence', actual: averageConfidence.toFixed(2) }));
};

const verifyDocumentPageCountReasonable: RuleLogicFn = (input) => {
  const totalPages = input.documents.reduce((sum, document) => {
    const pageCount = typeof document.pageCount === 'number' && Number.isFinite(document.pageCount)
      ? document.pageCount
      : (document.pages?.length ?? 0);
    return sum + pageCount;
  }, 0);

  if (totalPages > 50) {
    return fail(makeEvidence({ field: 'document_page_count', expected: '<= 50', actual: `${totalPages}` }));
  }

  return pass(makeEvidence({ field: 'document_page_count', actual: `${totalPages}` }));
};

const verifyRulepackIntegrity: RuleLogicFn = (input, params) => {
  const expectedChecksum = typeof params.expected_checksum === 'string'
    ? params.expected_checksum
    : typeof params.rulepack_checksum === 'string'
      ? params.rulepack_checksum
      : null;

  if (!expectedChecksum) {
    const integrityFlag = getBooleanField(input, ['rulepack_integrity_ok']);

    if (integrityFlag === false) {
      return fail(makeEvidence({ field: 'rulepack_integrity_ok', expected: 'true', actual: 'false' }));
    }

    if (integrityFlag === true) {
      return pass(makeEvidence({ field: 'rulepack_integrity_ok', actual: 'true' }));
    }

    return pass(makeEvidence({ field: 'rulepack_checksum', actual: 'not_configured' }));
  }

  const observedChecksum = getStringField(input, ['rulepack_checksum', 'active_rulepack_checksum']) ?? getField(input, 'rulepack_checksum')?.value?.toString() ?? null;

  if (!observedChecksum) {
    return incomplete('rulepack_checksum_missing', makeEvidence({ field: 'rulepack_checksum' }));
  }

  if (observedChecksum !== expectedChecksum) {
    return fail(makeEvidence({ field: 'rulepack_checksum', expected: expectedChecksum, actual: observedChecksum }));
  }

  return pass(makeEvidence({ field: 'rulepack_checksum', actual: observedChecksum }));
};

const verifyOverallClaimQualityScore: RuleLogicFn = (input) => {
  const scoreSignals = [
    (input.claim.lines?.length ?? 0) > 0,
    input.documents.length > 0,
    sumClaimLineTotals(input) > 0,
    getStringField(input, ['patient_name']) !== null || (input.claim.patientName ?? '').length > 0,
    getBooleanField(input, ['physician_signature_present']) === true,
  ];

  const score = scoreSignals.filter(Boolean).length / scoreSignals.length;

  if (score < 0.7) {
    return warning(makeEvidence({ field: 'overall_claim_quality_score', expected: '>= 0.70', actual: score.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'overall_claim_quality_score', actual: score.toFixed(2) }));
};

export const structuralRuleLogicRegistry: Record<string, RuleLogicFn> = {
  verify_claim_has_minimum_one_line: verifyClaimHasMinimumOneLine,
  verify_claim_has_documents: verifyClaimHasDocuments,
  verify_all_required_fields_present: verifyAllRequiredFieldsPresent,
  verify_dates_logically_consistent: verifyDatesLogicallyConsistent,
  verify_line_item_numbering: verifyLineItemNumbering,
  verify_claim_not_duplicate: verifyClaimNotDuplicate,
  verify_extraction_completeness: verifyExtractionCompleteness,
  verify_document_page_count_reasonable: verifyDocumentPageCountReasonable,
  verify_rulepack_integrity: verifyRulepackIntegrity,
  verify_overall_claim_quality_score: verifyOverallClaimQualityScore,
};

export const structuralRuleIds = {
  'STR-001': 'verify_claim_has_minimum_one_line',
  'STR-002': 'verify_claim_has_documents',
  'STR-003': 'verify_all_required_fields_present',
  'STR-004': 'verify_dates_logically_consistent',
  'STR-005': 'verify_line_item_numbering',
  'STR-006': 'verify_claim_not_duplicate',
  'STR-007': 'verify_extraction_completeness',
  'STR-008': 'verify_document_page_count_reasonable',
  'STR-009': 'verify_rulepack_integrity',
  'STR-010': 'verify_overall_claim_quality_score',
} as const;

