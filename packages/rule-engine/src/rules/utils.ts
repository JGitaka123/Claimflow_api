import { ClaimType, DocumentType, RuleResultStatus, type RuleEvidence } from '@claimflow/shared';
import type {
  DocumentSummary,
  ExtractedFieldValue,
  RegistryLookupResults,
  RuleEngineInput,
  RuleLogicOutput,
  TariffRecord,
} from '../types.js';

export function makeEvidence(input: {
  field?: string;
  expected?: string;
  actual?: string;
  documentId?: string;
  page?: number;
  reason?: string;
}): RuleEvidence {
  return {
    field: input.field,
    expected: input.expected,
    actual: input.actual,
    documentId: input.documentId,
    page: input.page,
    reason: input.reason,
  };
}

export function pass(evidence?: RuleEvidence): RuleLogicOutput {
  return evidence ? { result: RuleResultStatus.PASS, evidence } : { result: RuleResultStatus.PASS };
}

export function fail(evidence?: RuleEvidence): RuleLogicOutput {
  return evidence ? { result: RuleResultStatus.FAIL, evidence } : { result: RuleResultStatus.FAIL };
}

export function warning(evidence?: RuleEvidence): RuleLogicOutput {
  return evidence ? { result: RuleResultStatus.WARNING, evidence } : { result: RuleResultStatus.WARNING };
}

export function incomplete(reason: string, evidence?: RuleEvidence): RuleLogicOutput {
  return {
    result: RuleResultStatus.INCOMPLETE,
    evidence: evidence ?? makeEvidence({ reason }),
  };
}

export function getField(input: RuleEngineInput, key: string): ExtractedFieldValue | undefined {
  const direct = input.extractedFields.get(key);

  if (direct) {
    return direct;
  }

  const normalizedKey = normalizeKey(key);

  for (const [candidateKey, candidateValue] of input.extractedFields.entries()) {
    if (normalizeKey(candidateKey) === normalizedKey) {
      return candidateValue;
    }
  }

  return undefined;
}

export function getFieldValue(
  input: RuleEngineInput,
  keys: string[],
): string | number | boolean | null | undefined {
  for (const key of keys) {
    const found = getField(input, key);
    if (found && found.value !== undefined) {
      return found.value;
    }
  }

  return undefined;
}

export function getStringField(input: RuleEngineInput, keys: string[]): string | null {
  const value = getFieldValue(input, keys);
  return toNonEmptyString(value);
}

export function getNumberField(input: RuleEngineInput, keys: string[]): number | null {
  const value = getFieldValue(input, keys);
  return toNumber(value);
}

export function getBooleanField(input: RuleEngineInput, keys: string[]): boolean | null {
  const value = getFieldValue(input, keys);
  return toBoolean(value);
}

export function getDateField(input: RuleEngineInput, keys: string[]): Date | null {
  const value = getFieldValue(input, keys);
  if (typeof value !== 'string') {
    return null;
  }

  return parseDate(value);
}

export function getStringListField(input: RuleEngineInput, keys: string[]): string[] {
  const value = getFieldValue(input, keys);

  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(/[;,|]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const parsed = Number.parseFloat(trimmed.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (['true', 'yes', 'y', '1', 'present'].includes(normalized)) {
    return true;
  }

  if (['false', 'no', 'n', '0', 'absent', 'missing'].includes(normalized)) {
    return false;
  }

  return null;
}

export function parseDate(input: string): Date | null {
  const raw = input.trim();

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const yearPart = isoMatch[1];
    const monthPart = isoMatch[2];
    const dayPart = isoMatch[3];

    if (!yearPart || !monthPart || !dayPart) {
      return null;
    }

    const parsed = new Date(`${yearPart}-${monthPart}-${dayPart}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const dayPart = slashMatch[1];
    const monthPart = slashMatch[2];
    const yearPart = slashMatch[3];

    if (!dayPart || !monthPart || !yearPart) {
      return null;
    }

    const day = Number.parseInt(dayPart, 10);
    const month = Number.parseInt(monthPart, 10);
    const yearRaw = Number.parseInt(yearPart, 10);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;

    const parsed = new Date(Date.UTC(year, month - 1, day));

    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return null;
    }

    return parsed;
  }

  return null;
}

export function datesWithinDays(left: Date, right: Date, toleranceDays: number): boolean {
  const msPerDay = 24 * 60 * 60 * 1000;
  const deltaDays = Math.abs(left.getTime() - right.getTime()) / msPerDay;
  return deltaDays <= toleranceDays;
}

export function getDocumentsByType(input: RuleEngineInput, docType: DocumentType): DocumentSummary[] {
  return input.documents.filter((document) => document.docType === docType);
}

export function hasDocumentType(input: RuleEngineInput, docType: DocumentType): boolean {
  return getDocumentsByType(input, docType).length > 0;
}

export function extractDocumentText(document: DocumentSummary): string {
  const chunks: string[] = [];

  if (typeof document.textContent === 'string') {
    chunks.push(document.textContent);
  }

  const metadata = document.metadata;
  if (metadata && typeof metadata === 'object') {
    for (const key of ['ocrText', 'raw_text', 'text', 'content']) {
      const value = metadata[key];
      if (typeof value === 'string') {
        chunks.push(value);
      }
    }
  }

  return chunks.join(' ').trim();
}

export function getDocumentBooleanFlag(
  document: DocumentSummary,
  keys: string[],
): boolean | null {
  const metadata = document.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  for (const key of keys) {
    const value = metadata[key];
    const asBool = toBoolean(value);
    if (asBool !== null) {
      return asBool;
    }
  }

  return null;
}

export function getDocumentTextFlag(document: DocumentSummary, pattern: RegExp): boolean {
  const text = extractDocumentText(document);
  return pattern.test(text);
}

export function getDocumentQualityScore(document: DocumentSummary): number | null {
  const metadata = document.metadata;
  if (metadata && typeof metadata === 'object') {
    const qualityCandidate = metadata.imageQualityScore;
    if (typeof qualityCandidate === 'number' && Number.isFinite(qualityCandidate)) {
      return qualityCandidate;
    }

    const altQuality = metadata.qualityScore;
    if (typeof altQuality === 'number' && Number.isFinite(altQuality)) {
      return altQuality;
    }
  }

  const pageScores = (document.pages ?? [])
    .map((page) => (typeof page.imageQualityScore === 'number' ? page.imageQualityScore : null))
    .filter((score): score is number => score !== null);

  if (pageScores.length === 0) {
    return null;
  }

  const total = pageScores.reduce((sum, score) => sum + score, 0);
  return total / pageScores.length;
}

export function normalizedSimilarity(left: string, right: string): number {
  const a = normalizeText(left);
  const b = normalizeText(right);

  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  if (a.length < 2 || b.length < 2) {
    return 0;
  }

  const leftBigrams = makeBigrams(a);
  const rightBigrams = makeBigrams(b);

  let overlap = 0;
  const counts = new Map<string, number>();

  for (const gram of leftBigrams) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  for (const gram of rightBigrams) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

export function registryUnavailable(registryResults: RegistryLookupResults, key: 'patient' | 'facility' | 'practitioner'): boolean {
  if (registryResults.available === false) {
    return true;
  }

  return !registryResults[key];
}

export function claimDateReference(input: RuleEngineInput): Date | null {
  const fromClaim = typeof input.claim.admissionDate === 'string' ? parseDate(input.claim.admissionDate) : null;
  if (fromClaim) {
    return fromClaim;
  }

  return getDateField(input, ['admission_date', 'visit_date', 'claim_form_date']);
}

export function requiredClaimFormType(claimType: ClaimType): DocumentType {
  switch (claimType) {
    case ClaimType.INPATIENT:
      return DocumentType.SHA_CLAIM_FORM_IP;
    case ClaimType.MATERNITY:
      return DocumentType.SHA_CLAIM_FORM_MATERNITY;
    default:
      return DocumentType.SHA_CLAIM_FORM_OP;
  }
}

export function hasLineCategory(input: RuleEngineInput, options: {
  keywords: string[];
  codePrefixes?: string[];
  categoryKeys?: string[];
}): boolean {
  const lines = input.claim.lines ?? [];

  return lines.some((line) => {
    const description = `${line.description ?? ''}`.toLowerCase();
    const serviceCode = `${line.shaServiceCode ?? ''}`.toLowerCase();
    const asRecord = line as unknown as Record<string, unknown>;

    for (const prefix of options.codePrefixes ?? []) {
      if (serviceCode.startsWith(prefix.toLowerCase())) {
        return true;
      }
    }

    for (const keyword of options.keywords) {
      if (description.includes(keyword.toLowerCase())) {
        return true;
      }
    }

    for (const categoryKey of options.categoryKeys ?? []) {
      const value = asRecord[categoryKey];
      if (typeof value === 'string') {
        const normalizedValue = value.toLowerCase();
        if (options.keywords.some((keyword) => normalizedValue.includes(keyword.toLowerCase()))) {
          return true;
        }
      }
    }

    return false;
  });
}

export function getLineServiceCodes(input: RuleEngineInput): string[] {
  return (input.claim.lines ?? [])
    .map((line) => line.shaServiceCode?.trim().toUpperCase())
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function sumClaimLineTotals(input: RuleEngineInput): number {
  return (input.claim.lines ?? []).reduce((sum, line) => sum + (Number.isFinite(line.totalAmount) ? line.totalAmount : 0), 0);
}

export function countDuplicateLineItems(input: RuleEngineInput): number {
  const signatures = new Map<string, number>();

  for (const line of input.claim.lines ?? []) {
    const signature = `${line.shaServiceCode}|${line.description}|${line.unitPrice}|${line.totalAmount}`.toLowerCase();
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }

  let duplicateCount = 0;
  for (const count of signatures.values()) {
    if (count > 1) {
      duplicateCount += count - 1;
    }
  }

  return duplicateCount;
}

export function resolveTariff(
  input: RuleEngineInput,
  serviceCode: string,
  facilityTier: string,
): TariffRecord | null {
  const normalizedCode = serviceCode.trim().toUpperCase();
  const normalizedTier = facilityTier.trim().toUpperCase();

  if (input.tariffs.getTariff) {
    return input.tariffs.getTariff(normalizedCode, normalizedTier);
  }

  const candidates = input.tariffs.byServiceCode?.[normalizedCode];

  if (!candidates || candidates.length === 0) {
    return null;
  }

  const tierMatch = candidates.find(
    (candidate) => candidate.facilityTier.trim().toUpperCase() === normalizedTier,
  );

  return tierMatch ?? candidates[0] ?? null;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function makeBigrams(value: string): string[] {
  const grams: string[] = [];

  for (let i = 0; i < value.length - 1; i += 1) {
    grams.push(value.slice(i, i + 2));
  }

  return grams;
}
