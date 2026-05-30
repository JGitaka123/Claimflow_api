import { ClaimType } from '@claimflow/shared';
import type { RuleLogicFn } from '../types.js';
import {
  countDuplicateLineItems,
  fail,
  getBooleanField,
  getNumberField,
  hasLineCategory,
  incomplete,
  makeEvidence,
  pass,
  resolveTariff,
  sumClaimLineTotals,
  warning,
} from './utils.js';

function facilityTier(input: Parameters<RuleLogicFn>[0]): string {
  return (input.facilityContext.facilityTier ?? 'UNKNOWN').trim().toUpperCase();
}

function claimTotal(input: Parameters<RuleLogicFn>[0]): number {
  const explicit = getNumberField(input, ['claim_total_amount', 'total_claim_amount']);
  return explicit ?? sumClaimLineTotals(input);
}

const verifyTariffCodeExists: RuleLogicFn = (input) => {
  const lines = input.claim.lines ?? [];

  if (lines.length === 0) {
    return fail(makeEvidence({ field: 'claim_lines', expected: 'at least one line', actual: 'missing' }));
  }

  const tier = facilityTier(input);

  for (const line of lines) {
    const code = line.shaServiceCode?.trim();

    if (!code) {
      return fail(makeEvidence({ field: 'sha_service_code', expected: 'non-empty', actual: 'missing' }));
    }

    const tariff = resolveTariff(input, code, tier);

    if (!tariff) {
      return fail(makeEvidence({ field: 'sha_service_code', expected: 'active tariff code', actual: code }));
    }
  }

  return pass(makeEvidence({ field: 'sha_service_code', actual: 'all_codes_found' }));
};

const verifyAmountWithinTariff: RuleLogicFn = (input) => {
  const lines = input.claim.lines ?? [];

  if (lines.length === 0) {
    return fail(makeEvidence({ field: 'claim_lines', expected: 'at least one line', actual: 'missing' }));
  }

  const tier = facilityTier(input);

  for (const line of lines) {
    const code = line.shaServiceCode?.trim();

    if (!code) {
      return fail(makeEvidence({ field: 'sha_service_code', expected: 'non-empty', actual: 'missing' }));
    }

    const tariff = resolveTariff(input, code, tier);

    if (!tariff) {
      return incomplete('tariff_missing_for_line', makeEvidence({ field: 'sha_service_code', actual: code }));
    }

    const maxAllowed = tariff.maxAmount * Math.max(line.quantity, 1);

    if (line.totalAmount > maxAllowed) {
      return fail(makeEvidence({ field: 'line_total_amount', expected: `<= ${maxAllowed.toFixed(2)}`, actual: line.totalAmount.toFixed(2) }));
    }
  }

  return pass(makeEvidence({ field: 'line_total_amount', actual: 'within_tariff_limits' }));
};

const verifyTariffTierMatches: RuleLogicFn = (input) => {
  const tier = facilityTier(input);

  for (const line of input.claim.lines ?? []) {
    const code = line.shaServiceCode?.trim();

    if (!code) {
      continue;
    }

    const tariff = resolveTariff(input, code, tier);

    if (!tariff) {
      return incomplete('tariff_missing_for_line', makeEvidence({ field: 'sha_service_code', actual: code }));
    }

    if (tariff.facilityTier.trim().toUpperCase() !== tier) {
      return fail(makeEvidence({ field: 'facility_tier', expected: tier, actual: tariff.facilityTier }));
    }
  }

  return pass(makeEvidence({ field: 'facility_tier', actual: tier }));
};

const verifyQuantityReasonable: RuleLogicFn = (input) => {
  for (const line of input.claim.lines ?? []) {
    if (line.quantity <= 0 || line.quantity > 100) {
      return fail(makeEvidence({ field: 'quantity', expected: '1-100', actual: `${line.quantity}` }));
    }
  }

  return pass(makeEvidence({ field: 'quantity', actual: 'reasonable' }));
};

const verifyNoUnbundling: RuleLogicFn = (input) => {
  const duplicateCount = countDuplicateLineItems(input);

  if (duplicateCount >= 3) {
    return fail(makeEvidence({ field: 'line_items', expected: 'no suspicious split billing', actual: `${duplicateCount} duplicate entries` }));
  }

  return pass(makeEvidence({ field: 'line_items', actual: 'no_unbundling_detected' }));
};

const verifyNoUpcoding: RuleLogicFn = (input) => {
  const suspiciousLine = (input.claim.lines ?? []).find((line) => {
    const description = line.description.toLowerCase();
    const code = line.shaServiceCode.toUpperCase();
    return description.includes('specialized') && code.startsWith('GEN');
  });

  if (suspiciousLine) {
    return fail(makeEvidence({ field: 'sha_service_code', expected: 'code complexity matches description', actual: suspiciousLine.shaServiceCode }));
  }

  return pass(makeEvidence({ field: 'coding_consistency', actual: 'no_upcoding_signal' }));
};

const verifyTotalMatchesLines: RuleLogicFn = (input) => {
  const totalFromLines = sumClaimLineTotals(input);
  const declaredTotal = claimTotal(input);
  const delta = Math.abs(totalFromLines - declaredTotal);

  if (delta > 1) {
    return fail(makeEvidence({ field: 'claim_total_amount', expected: totalFromLines.toFixed(2), actual: declaredTotal.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'claim_total_amount', actual: declaredTotal.toFixed(2) }));
};

const verifyUnitPriceConsistent: RuleLogicFn = (input) => {
  const tier = facilityTier(input);

  for (const line of input.claim.lines ?? []) {
    const code = line.shaServiceCode?.trim();

    if (!code) {
      continue;
    }

    const tariff = resolveTariff(input, code, tier);

    if (!tariff) {
      return incomplete('tariff_missing_for_line', makeEvidence({ field: 'sha_service_code', actual: code }));
    }

    if (line.unitPrice > tariff.maxAmount) {
      return warning(makeEvidence({ field: 'unit_price', expected: `<= ${tariff.maxAmount.toFixed(2)}`, actual: line.unitPrice.toFixed(2) }));
    }
  }

  return pass(makeEvidence({ field: 'unit_price', actual: 'consistent_with_tariff' }));
};

const verifyPharmacyItemsFormulary: RuleLogicFn = (input) => {
  const hasPharmacy = hasLineCategory(input, {
    keywords: ['pharmacy', 'drug', 'medicine', 'medication'],
    codePrefixes: ['RX', 'PHARM'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!hasPharmacy) {
    return pass(makeEvidence({ field: 'pharmacy_items', actual: 'not_applicable' }));
  }

  const formularyApproved = getBooleanField(input, ['formulary_approved', 'pharmacy_formulary_ok']);

  if (formularyApproved === false) {
    return fail(makeEvidence({ field: 'formulary_approved', expected: 'true', actual: 'false' }));
  }

  if (formularyApproved === null) {
    return incomplete('formulary_status_missing', makeEvidence({ field: 'formulary_approved' }));
  }

  return pass(makeEvidence({ field: 'formulary_approved', actual: 'true' }));
};

const verifyLosChargesMatchDates: RuleLogicFn = (input) => {
  const bedDaysCharged = getNumberField(input, ['bed_days_charged']);
  const lengthOfStayDays = getNumberField(input, ['length_of_stay_days']);

  if (bedDaysCharged === null || lengthOfStayDays === null) {
    return incomplete('los_or_bed_days_missing', makeEvidence({ field: 'bed_days_charged' }));
  }

  if (bedDaysCharged > lengthOfStayDays + 1) {
    return fail(makeEvidence({ field: 'bed_days_charged', expected: `<= ${lengthOfStayDays + 1}`, actual: `${bedDaysCharged}` }));
  }

  return pass(makeEvidence({ field: 'bed_days_charged', actual: `${bedDaysCharged}` }));
};

const verifyConsultationFeeAppropriate: RuleLogicFn = (input) => {
  const consultationLine = (input.claim.lines ?? []).find((line) => /consult/i.test(line.description));

  if (!consultationLine) {
    return pass(makeEvidence({ field: 'consultation_fee', actual: 'not_applicable' }));
  }

  const tariff = resolveTariff(input, consultationLine.shaServiceCode, facilityTier(input));

  if (!tariff) {
    return incomplete('consultation_tariff_missing', makeEvidence({ field: 'sha_service_code', actual: consultationLine.shaServiceCode }));
  }

  if (consultationLine.totalAmount > tariff.maxAmount * Math.max(consultationLine.quantity, 1)) {
    return fail(makeEvidence({ field: 'consultation_fee', expected: `<= ${tariff.maxAmount.toFixed(2)}`, actual: consultationLine.totalAmount.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'consultation_fee', actual: consultationLine.totalAmount.toFixed(2) }));
};

const verifySurgicalFeesMatchProcedure: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.SURGICAL && !hasLineCategory(input, {
    keywords: ['surgery', 'operative'],
    codePrefixes: ['SURG', 'PROC'],
    categoryKeys: ['category', 'serviceCategory'],
  })) {
    return pass(makeEvidence({ field: 'surgical_fee', actual: 'not_applicable' }));
  }

  const invalid = (input.claim.lines ?? []).find((line) =>
    /surg|operat/i.test(line.description) && (!line.procedureCode || line.procedureCode.trim().length === 0),
  );

  if (invalid) {
    return fail(makeEvidence({ field: 'procedure_code', expected: 'present for surgical fee', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'surgical_fee', actual: 'procedure_documented' }));
};

const verifyNoDuplicateLineItems: RuleLogicFn = (input) => {
  const duplicateCount = countDuplicateLineItems(input);

  if (duplicateCount > 0) {
    return warning(makeEvidence({ field: 'line_items', expected: 'no duplicates', actual: `${duplicateCount} duplicates` }));
  }

  return pass(makeEvidence({ field: 'line_items', actual: 'unique' }));
};

const verifyMaternityPackageRate: RuleLogicFn = (input) => {
  if (input.claim.claimType !== ClaimType.MATERNITY) {
    return pass(makeEvidence({ field: 'claim_type', actual: input.claim.claimType }));
  }

  const packageRateApplied = getBooleanField(input, ['maternity_package_rate_applied']);

  if (packageRateApplied === false) {
    return fail(makeEvidence({ field: 'maternity_package_rate_applied', expected: 'true', actual: 'false' }));
  }

  if (packageRateApplied === null) {
    return incomplete('maternity_package_flag_missing', makeEvidence({ field: 'maternity_package_rate_applied' }));
  }

  return pass(makeEvidence({ field: 'maternity_package_rate_applied', actual: 'true' }));
};

const verifyRenalSessionRate: RuleLogicFn = (input) => {
  const renalClaim = input.claim.claimType === ClaimType.RENAL || hasLineCategory(input, {
    keywords: ['dialysis', 'renal'],
    codePrefixes: ['REN', 'DIAL'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!renalClaim) {
    return pass(makeEvidence({ field: 'renal_rate', actual: 'not_applicable' }));
  }

  const tier = facilityTier(input);

  for (const line of input.claim.lines ?? []) {
    if (!/dialysis|renal/i.test(line.description) && !/^REN|^DIAL/i.test(line.shaServiceCode)) {
      continue;
    }

    const tariff = resolveTariff(input, line.shaServiceCode, tier);

    if (!tariff) {
      return incomplete('renal_tariff_missing', makeEvidence({ field: 'sha_service_code', actual: line.shaServiceCode }));
    }

    if (line.unitPrice > tariff.maxAmount) {
      return fail(makeEvidence({ field: 'unit_price', expected: `<= ${tariff.maxAmount.toFixed(2)}`, actual: line.unitPrice.toFixed(2) }));
    }
  }

  return pass(makeEvidence({ field: 'renal_rate', actual: 'within_tariff' }));
};

const verifyClaimTotalWithinExpectedRange: RuleLogicFn = (input) => {
  const total = claimTotal(input);

  if (total > 2_000_000) {
    return warning(makeEvidence({ field: 'claim_total_amount', expected: '<= 2,000,000', actual: total.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'claim_total_amount', actual: total.toFixed(2) }));
};

const verifyIcuChargesJustified: RuleLogicFn = (input) => {
  const hasIcuCharges = hasLineCategory(input, {
    keywords: ['icu', 'intensive care'],
    codePrefixes: ['ICU'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!hasIcuCharges) {
    return pass(makeEvidence({ field: 'icu_charges', actual: 'not_applicable' }));
  }

  const icuDocumented = getBooleanField(input, ['icu_admission_documented']) === true;
  const accommodationType = `${input.claim.accommodationType ?? ''}`.toUpperCase();

  if (!icuDocumented && accommodationType !== 'ICU') {
    return fail(makeEvidence({ field: 'icu_charges', expected: 'ICU documentation', actual: 'missing' }));
  }

  return pass(makeEvidence({ field: 'icu_charges', actual: 'justified' }));
};

const verifyImplantCostsDocumented: RuleLogicFn = (input) => {
  const hasImplantLines = hasLineCategory(input, {
    keywords: ['implant', 'stent', 'prosthesis'],
    codePrefixes: ['IMP'],
    categoryKeys: ['category', 'serviceCategory'],
  });

  if (!hasImplantLines) {
    return pass(makeEvidence({ field: 'implant_costs', actual: 'not_applicable' }));
  }

  const documented = getBooleanField(input, ['implant_documentation_present', 'implant_invoice_present']);

  if (documented !== true) {
    return fail(makeEvidence({ field: 'implant_documentation', expected: 'true', actual: `${documented ?? 'missing'}` }));
  }

  return pass(makeEvidence({ field: 'implant_documentation', actual: 'present' }));
};

const verifyBenefitLimitNotExceeded: RuleLogicFn = (input) => {
  const annualUsed = getNumberField(input, ['annual_benefit_used']);
  const annualLimit = getNumberField(input, ['annual_benefit_limit']);

  if (annualUsed === null || annualLimit === null) {
    return incomplete('benefit_limit_data_missing', makeEvidence({ field: 'annual_benefit_limit' }));
  }

  const projected = annualUsed + claimTotal(input);

  if (projected > annualLimit) {
    return fail(makeEvidence({ field: 'annual_benefit_limit', expected: `>= ${projected.toFixed(2)}`, actual: annualLimit.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'annual_benefit_limit', actual: annualLimit.toFixed(2) }));
};

const verifyFinancialCompletenessScore: RuleLogicFn = (input) => {
  const checks = [
    (input.claim.lines ?? []).length > 0,
    getBooleanField(input, ['duplicate_claim_detected']) !== true,
    getNumberField(input, ['claim_total_amount', 'total_claim_amount']) !== null,
    getNumberField(input, ['annual_benefit_limit']) !== null,
    getBooleanField(input, ['formulary_approved']) !== false,
  ];

  const score = checks.filter(Boolean).length / checks.length;

  if (score < 0.7) {
    return warning(makeEvidence({ field: 'financial_completeness_score', expected: '>= 0.70', actual: score.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'financial_completeness_score', actual: score.toFixed(2) }));
};

const verifyHospitalApprovedMatchesClaim: RuleLogicFn = (input) => {
  const hospitalApproved = input.claim.hospitalApprovedTotal;

  if (typeof hospitalApproved !== 'number') {
    return incomplete('hospital_approved_total_missing', makeEvidence({ field: 'hospital_approved_total' }));
  }

  const total = sumClaimLineTotals(input);

  if (total <= 0) {
    return incomplete('claim_line_totals_missing', makeEvidence({ field: 'claim_lines' }));
  }

  const variance = Math.abs(hospitalApproved - total) / total;

  if (variance > 0.05) {
    return warning(makeEvidence({ field: 'hospital_approved_total', expected: `${total.toFixed(2)} +/-5%`, actual: hospitalApproved.toFixed(2) }));
  }

  return pass(makeEvidence({ field: 'hospital_approved_total', actual: hospitalApproved.toFixed(2) }));
};

export const financialRuleLogicRegistry: Record<string, RuleLogicFn> = {
  verify_tariff_code_exists: verifyTariffCodeExists,
  verify_amount_within_tariff: verifyAmountWithinTariff,
  verify_tariff_tier_matches: verifyTariffTierMatches,
  verify_quantity_reasonable: verifyQuantityReasonable,
  verify_no_unbundling: verifyNoUnbundling,
  verify_no_upcoding: verifyNoUpcoding,
  verify_total_matches_lines: verifyTotalMatchesLines,
  verify_unit_price_consistent: verifyUnitPriceConsistent,
  verify_pharmacy_items_formulary: verifyPharmacyItemsFormulary,
  verify_los_charges_match_dates: verifyLosChargesMatchDates,
  verify_consultation_fee_appropriate: verifyConsultationFeeAppropriate,
  verify_surgical_fees_match_procedure: verifySurgicalFeesMatchProcedure,
  verify_no_duplicate_line_items: verifyNoDuplicateLineItems,
  verify_maternity_package_rate: verifyMaternityPackageRate,
  verify_renal_session_rate: verifyRenalSessionRate,
  verify_claim_total_within_expected_range: verifyClaimTotalWithinExpectedRange,
  verify_icu_charges_justified: verifyIcuChargesJustified,
  verify_implant_costs_documented: verifyImplantCostsDocumented,
  verify_benefit_limit_not_exceeded: verifyBenefitLimitNotExceeded,
  verify_financial_completeness_score: verifyFinancialCompletenessScore,
  verify_hospital_approved_matches_claim: verifyHospitalApprovedMatchesClaim,
};

export const financialRuleIds = {
  'FIN-001': 'verify_tariff_code_exists',
  'FIN-002': 'verify_amount_within_tariff',
  'FIN-003': 'verify_tariff_tier_matches',
  'FIN-004': 'verify_quantity_reasonable',
  'FIN-005': 'verify_no_unbundling',
  'FIN-006': 'verify_no_upcoding',
  'FIN-007': 'verify_total_matches_lines',
  'FIN-008': 'verify_unit_price_consistent',
  'FIN-009': 'verify_pharmacy_items_formulary',
  'FIN-010': 'verify_los_charges_match_dates',
  'FIN-011': 'verify_consultation_fee_appropriate',
  'FIN-012': 'verify_surgical_fees_match_procedure',
  'FIN-013': 'verify_no_duplicate_line_items',
  'FIN-014': 'verify_maternity_package_rate',
  'FIN-015': 'verify_renal_session_rate',
  'FIN-016': 'verify_claim_total_within_expected_range',
  'FIN-017': 'verify_icu_charges_justified',
  'FIN-018': 'verify_implant_costs_documented',
  'FIN-019': 'verify_benefit_limit_not_exceeded',
  'FIN-020': 'verify_financial_completeness_score',
  'FIN-021': 'verify_hospital_approved_matches_claim',
} as const;


