import { describe, expect, it } from 'vitest';
import {
  BatchAuditSchema,
  ChangePasswordSchema,
  CreateClaimSchema,
  CreatePreauthorizationSchema,
} from '../validation/schemas.js';
import { DocProcessingRoute, DOC_PROCESSING_ROUTES, DocumentType } from '../types/document.js';
import { VisitType } from '../types/claim.js';
import { PreauthorizationStatus } from '../types/preauthorization.js';

describe('shared schemas', () => {
  it('applies default visit type when creating a claim', () => {
    const parsed = CreateClaimSchema.parse({
      facilityId: '11111111-1111-1111-1111-111111111111',
      claimType: 'OUTPATIENT',
      admissionDate: '2026-03-09',
    });

    expect(parsed.visitType).toBe(VisitType.OP);
  });

  it('validates password strength policy', () => {
    const weak = ChangePasswordSchema.safeParse({
      currentPassword: 'Password!123',
      newPassword: 'weak',
    });
    expect(weak.success).toBe(false);

    const strong = ChangePasswordSchema.safeParse({
      currentPassword: 'Password!123',
      newPassword: 'StrongPassword!456',
    });
    expect(strong.success).toBe(true);
  });

  it('defaults batch audit concurrency', () => {
    const parsed = BatchAuditSchema.parse({
      claimIds: ['11111111-1111-1111-1111-111111111111'],
    });

    expect(parsed.concurrency).toBe(4);
  });

  it('applies preauthorization defaults and requires service codes', () => {
    const parsed = CreatePreauthorizationSchema.parse({
      preauthNumber: 'PREAUTH-001',
      patientShaId: 'CR123456789-1',
      validTo: '2026-03-31',
      serviceCodes: [{ shaServiceCode: 'SHA-001' }],
    });

    expect(parsed.status).toBe(PreauthorizationStatus.ACTIVE);
    expect(parsed.source).toBe('MANUAL_ENTRY');

    const invalid = CreatePreauthorizationSchema.safeParse({
      preauthNumber: 'PREAUTH-001',
      patientShaId: 'CR123456789-1',
      validTo: '2026-03-31',
      serviceCodes: [],
    });
    expect(invalid.success).toBe(false);
  });
});

describe('document routing matrix', () => {
  it('maps known document types to expected processing routes', () => {
    expect(DOC_PROCESSING_ROUTES[DocumentType.CONSENT_FORM]).toBe(DocProcessingRoute.SIGNATURE_DETECT_ONLY);
    expect(DOC_PROCESSING_ROUTES[DocumentType.NATIONAL_ID_COPY]).toBe(DocProcessingRoute.EXISTENCE_QUALITY_ONLY);
    expect(DOC_PROCESSING_ROUTES[DocumentType.SHA_CLAIM_FORM_OP]).toBe(DocProcessingRoute.FULL_OCR_EXTRACT);
  });

  it('covers every declared document type', () => {
    const routeCount = Object.keys(DOC_PROCESSING_ROUTES).length;
    const docTypeCount = Object.keys(DocumentType).length;

    expect(routeCount).toBe(docTypeCount);
  });
});
