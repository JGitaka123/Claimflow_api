// ============================================================================
// ZOD VALIDATION SCHEMAS — Section 10 (API Contracts)
// ============================================================================

import { z } from 'zod';
import { ClaimType, VisitType } from '../types/claim.js';
import { DocumentType } from '../types/document.js';
import { PreauthorizationStatus } from '../types/preauthorization.js';

// --- Claims ---

export const CreateClaimSchema = z.object({
  facilityId: z.string().uuid(),
  claimType: z.nativeEnum(ClaimType),
  visitType: z.nativeEnum(VisitType).default(VisitType.OP),
  patientShaId: z.string().max(50).optional(),
  patientName: z.string().max(200).optional(),
  patientNationalId: z.string().max(50).optional(),
  hmisRef: z.string().max(100).optional(),
  admissionDate: z.string().date(),
  dischargeDate: z.string().date().optional(),
  primaryDiagnosisCode: z.string().max(20).optional(),
  shaBenefitPackage: z.string().max(20).optional(),
  preauthNumber: z.string().max(100).optional(),
  accommodationType: z.string().max(50).optional(),
  lines: z.array(z.object({
    shaServiceCode: z.string().min(1).max(50),
    description: z.string().min(1).max(500),
    icdCode: z.string().max(20).optional(),
    procedureCode: z.string().max(50).optional(),
    caseCode: z.string().max(10).optional(),
    quantity: z.number().int().min(1),
    unitPrice: z.number().min(0),
    billAmount: z.number().min(0).optional(),
  })).optional(),
});
export type CreateClaimInput = z.infer<typeof CreateClaimSchema>;

export const UpdateClaimSchema = z.object({
  patientShaId: z.string().max(50).optional(),
  patientName: z.string().max(200).optional(),
  patientNationalId: z.string().max(50).optional(),
  hmisRef: z.string().max(100).optional(),
  admissionDate: z.string().date().optional(),
  dischargeDate: z.string().date().optional(),
  primaryDiagnosisCode: z.string().max(20).optional(),
  shaBenefitPackage: z.string().max(20).optional(),
  preauthNumber: z.string().max(100).optional(),
  accommodationType: z.string().max(50).optional(),
  hospitalApprovedTotal: z.number().min(0).optional(),
  lines: z.array(z.object({
    shaServiceCode: z.string().min(1).max(50),
    description: z.string().min(1).max(500),
    icdCode: z.string().max(20).optional(),
    procedureCode: z.string().max(50).optional(),
    caseCode: z.string().max(10).optional(),
    quantity: z.number().int().min(1),
    unitPrice: z.number().min(0),
    billAmount: z.number().min(0).optional(),
  })).optional(),
});
export type UpdateClaimInput = z.infer<typeof UpdateClaimSchema>;

export const ListClaimsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().optional(), // Comma-separated ClaimStatus values
  claimType: z.nativeEnum(ClaimType).optional(),
  facilityId: z.string().uuid().optional(),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  q: z.string().max(200).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'admissionDate']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type ListClaimsQuery = z.infer<typeof ListClaimsQuerySchema>;

// --- Documents ---

export const UploadDocumentSchema = z.object({
  docType: z.nativeEnum(DocumentType),
});
export type UploadDocumentInput = z.infer<typeof UploadDocumentSchema>;

// --- Audit ---

export const TriggerAuditSchema = z.object({
  forceReprocess: z.boolean().default(false),
});
export type TriggerAuditInput = z.infer<typeof TriggerAuditSchema>;

export const BatchAuditSchema = z.object({
  claimIds: z.array(z.string().uuid()).max(200).optional(),
  filter: z.object({
    status: z.literal('DOCUMENTS_UPLOADED'),
    facilityId: z.string().uuid().optional(),
    dateFrom: z.string().date().optional(),
    dateTo: z.string().date().optional(),
  }).optional(),
  concurrency: z.number().int().min(1).max(8).default(4),
});
export type BatchAuditInput = z.infer<typeof BatchAuditSchema>;

export const OverrideRequestSchema = z.object({
  reason: z.string().min(20, 'Override reason must be at least 20 characters').max(2000),
});
export type OverrideRequestInput = z.infer<typeof OverrideRequestSchema>;

export const ApproveOverrideSchema = z.object({
  supervisorNotes: z.string().max(2000).optional(),
});
export type ApproveOverrideInput = z.infer<typeof ApproveOverrideSchema>;

// --- Field Correction ---

export const CorrectFieldSchema = z.object({
  correctedValue: z.string().min(1).max(1000),
});
export type CorrectFieldInput = z.infer<typeof CorrectFieldSchema>;

// --- Auth ---

export const LoginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const MfaVerifySchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().length(6).regex(/^\d{6}$/, 'TOTP code must be 6 digits'),
});
export type MfaVerifyInput = z.infer<typeof MfaVerifySchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string()
    .min(12, 'Password must be at least 12 characters')
    .regex(/[A-Z]/, 'Password must contain uppercase letter')
    .regex(/[a-z]/, 'Password must contain lowercase letter')
    .regex(/[0-9]/, 'Password must contain a digit')
    .regex(/[^A-Za-z0-9]/, 'Password must contain a special character'),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

// --- Preauthorizations ---

const PreauthorizationServiceCodeSchema = z.object({
  shaServiceCode: z.string().min(1).max(50),
  quantityAuthorized: z.number().int().min(1).optional(),
  maxAmountKes: z.number().min(0).optional(),
});

export const CreatePreauthorizationSchema = z.object({
  preauthNumber: z.string().min(4).max(100),
  patientShaId: z.string().min(1).max(50),
  facilityId: z.string().uuid().optional(),
  status: z.nativeEnum(PreauthorizationStatus).default(PreauthorizationStatus.ACTIVE),
  validFrom: z.string().date().optional(),
  validTo: z.string().date(),
  approvedAt: z.string().datetime().optional(),
  source: z.string().min(1).max(100).default('MANUAL_ENTRY'),
  serviceCodes: z.array(PreauthorizationServiceCodeSchema).min(1),
  metadata: z.record(z.unknown()).optional(),
});
export type CreatePreauthorizationInput = z.infer<typeof CreatePreauthorizationSchema>;
// --- Export ---

export const ExportEvidenceSchema = z.object({
  auditSessionId: z.string().uuid().optional(), // Latest if omitted
});
export type ExportEvidenceInput = z.infer<typeof ExportEvidenceSchema>;

