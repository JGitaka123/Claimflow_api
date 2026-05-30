import { ClaimType, DocumentType } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import type { DocumentSummary } from '../../../src/types.js';
import {
  claimDateReference,
  datesWithinDays,
  extractDocumentText,
  fail,
  getBooleanField,
  getDateField,
  getDocumentBooleanFlag,
  getDocumentQualityScore,
  getField,
  getFieldValue,
  getStringField,
  hasDocumentType,
  hasLineCategory,
  incomplete,
  makeEvidence,
  normalizedSimilarity,
  parseDate,
  pass,
  registryUnavailable,
  requiredClaimFormType,
  toBoolean,
  toNonEmptyString,
  warning,
} from '../../../src/rules/utils.js';
import { createRuleInput, makeLine, setField } from './rule-test-helpers.js';

describe('rules/utils coverage', () => {
  it('covers pass/fail/warning/incomplete evidence branches', () => {
    const evidence = makeEvidence({ field: 'x', actual: 'y' });

    expect(pass().result).toBe('PASS');
    expect(pass(evidence).evidence?.field).toBe('x');

    expect(fail().result).toBe('FAIL');
    expect(fail(evidence).evidence?.field).toBe('x');

    expect(warning().result).toBe('WARNING');
    expect(warning(evidence).evidence?.field).toBe('x');

    expect(incomplete('missing').result).toBe('INCOMPLETE');
    expect(incomplete('missing').evidence?.reason).toBe('missing');
    expect(incomplete('missing', evidence).evidence?.field).toBe('x');
  });

  it('covers field lookup and primitive converters', () => {
    const input = createRuleInput();
    input.extractedFields.set('patient-sha-id', { key: 'patient-sha-id', value: 'CR100000000-1' });

    expect(getField(input, 'patient_sha_id')?.value).toBe('CR100000000-1');
    expect(getFieldValue(input, ['missing', 'patient_sha_id'])).toBe('CR100000000-1');
    expect(getStringField(input, ['patient_sha_id'])).toBe('CR100000000-1');

    setField(input, 'flag1', 1);
    setField(input, 'flag0', 0);
    expect(getBooleanField(input, ['flag1'])).toBe(true);
    expect(getBooleanField(input, ['flag0'])).toBe(false);

    expect(toNonEmptyString('  value  ')).toBe('value');
    expect(toNonEmptyString('   ')).toBeNull();
    expect(toNonEmptyString(123)).toBeNull();

    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(2)).toBeNull();
    expect(toBoolean(' yes ')).toBe(true);
    expect(toBoolean('missing')).toBe(false);
    expect(toBoolean('unknown')).toBeNull();
    expect(toBoolean({})).toBeNull();
  });

  it('covers date parsing variants and date field access', () => {
    const input = createRuleInput();
    setField(input, 'claim_form_date', '2026-03-05');

    expect(getDateField(input, ['claim_form_date'])?.toISOString().slice(0, 10)).toBe('2026-03-05');
    expect(getDateField(input, ['missing'])).toBeNull();

    setField(input, 'numeric_date', 1234);
    expect(getDateField(input, ['numeric_date'])).toBeNull();

    expect(parseDate('2026-03-05')?.toISOString().slice(0, 10)).toBe('2026-03-05');
    expect(parseDate('5/03/26')?.toISOString().slice(0, 10)).toBe('2026-03-05');
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('not-a-date')).toBeNull();

    const left = new Date('2026-03-05T00:00:00.000Z');
    const right = new Date('2026-03-06T00:00:00.000Z');
    expect(datesWithinDays(left, right, 1)).toBe(true);
    expect(datesWithinDays(left, right, 0)).toBe(false);
  });

  it('covers document text/flag/quality helpers', () => {
    const docWithMeta: DocumentSummary = {
      id: 'doc-1',
      docType: DocumentType.PHYSICIAN_NOTES,
      metadata: {
        ocrText: 'alpha',
        raw_text: 'beta',
        text: 'gamma',
        content: 'delta',
        signature_present: 'present',
        qualityScore: 0.73,
      },
    };

    expect(extractDocumentText(docWithMeta)).toContain('alpha');
    expect(getDocumentBooleanFlag(docWithMeta, ['signature_present'])).toBe(true);
    expect(getDocumentBooleanFlag(docWithMeta, ['missing_flag'])).toBeNull();
    expect(getDocumentQualityScore(docWithMeta)).toBe(0.73);

    const docWithPages: DocumentSummary = {
      id: 'doc-2',
      docType: DocumentType.NATIONAL_ID_COPY,
      pages: [
        {} as Record<string, unknown>,
        { imageQualityScore: 0.4 },
        { imageQualityScore: 0.8 },
      ],
    };

    expect(getDocumentQualityScore(docWithPages)).toBeCloseTo(0.6, 5);

    const docWithInvalidMetaScore: DocumentSummary = {
      id: 'doc-2b',
      docType: DocumentType.NATIONAL_ID_COPY,
      metadata: {
        imageQualityScore: '0.9',
      },
      pages: [{ imageQualityScore: 0.5 }],
    };
    expect(getDocumentQualityScore(docWithInvalidMetaScore)).toBe(0.5);

    expect(getDocumentQualityScore({ id: 'doc-3', docType: DocumentType.NATIONAL_ID_COPY })).toBeNull();
  });

  it('covers similarity, registry status, claim date and line-category helpers', () => {
    expect(normalizedSimilarity('', 'abc')).toBe(0);
    expect(normalizedSimilarity('a', 'b')).toBe(0);
    expect(normalizedSimilarity('abc', 'abc')).toBe(1);
    expect(normalizedSimilarity('alfa', 'alpha')).toBeGreaterThan(0);

    expect(registryUnavailable({ available: false }, 'patient')).toBe(true);
    expect(registryUnavailable({ available: true, patient: { found: true } }, 'patient')).toBe(false);

    const inputWithFallbackDate = createRuleInput();
    (inputWithFallbackDate.claim as Record<string, unknown>).admissionDate = undefined;
    setField(inputWithFallbackDate, 'admission_date', '2026-03-07');
    expect(claimDateReference(inputWithFallbackDate)?.toISOString().slice(0, 10)).toBe('2026-03-07');

    expect(requiredClaimFormType(ClaimType.INPATIENT)).toBe(DocumentType.SHA_CLAIM_FORM_IP);
    expect(requiredClaimFormType(ClaimType.MATERNITY)).toBe(DocumentType.SHA_CLAIM_FORM_MATERNITY);
    expect(requiredClaimFormType(ClaimType.OUTPATIENT)).toBe(DocumentType.SHA_CLAIM_FORM_OP);

    const input = createRuleInput();
    input.documents = [{ id: 'd1', docType: DocumentType.PRESCRIPTION }];
    expect(hasDocumentType(input, DocumentType.PRESCRIPTION)).toBe(true);

    (input.claim as Record<string, unknown>).lines = undefined;
    expect(hasLineCategory(input, { keywords: ['lab'] })).toBe(false);

    input.claim.lines = [makeLine({ shaServiceCode: 'LAB-001', description: 'General service' })];
    expect(hasLineCategory(input, { keywords: ['lab'], codePrefixes: ['lab'] })).toBe(true);

    input.claim.lines = [makeLine({ shaServiceCode: 'GEN-001', description: 'Laboratory panel' })];
    expect(hasLineCategory(input, { keywords: ['laboratory'] })).toBe(true);

    input.claim.lines = [makeLine({ shaServiceCode: 'GEN-001', description: 'Consultation' })];
    expect(hasLineCategory(input, { keywords: ['pharmacy'] })).toBe(false);

    const sparseLine = makeLine() as unknown as Record<string, unknown>;
    sparseLine.description = undefined;
    sparseLine.shaServiceCode = undefined;
    sparseLine.category = 123;
    input.claim.lines = [sparseLine as unknown as ReturnType<typeof makeLine>];
    expect(hasLineCategory(input, { keywords: ['pharmacy'], categoryKeys: ['category'] })).toBe(false);

    const categoryLine = makeLine({ shaServiceCode: 'GEN-001', description: 'General service' }) as unknown as Record<string, unknown>;
    categoryLine.category = 'Pharmacy Item';
    input.claim.lines = [categoryLine as unknown as ReturnType<typeof makeLine>];
    expect(hasLineCategory(input, { keywords: ['pharmacy'], categoryKeys: ['category'] })).toBe(true);
  });
});
