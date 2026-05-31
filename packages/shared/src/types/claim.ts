// ============================================================================
// CLAIM TYPES — Section 8 (State Machine) + Section 9 (Schema)
// ============================================================================

export enum ClaimStatus {
  DRAFT = 'DRAFT',
  DOCUMENTS_UPLOADED = 'DOCUMENTS_UPLOADED',
  PROCESSING = 'PROCESSING',
  AUDIT_COMPLETE = 'AUDIT_COMPLETE',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  WARNING = 'WARNING',
  OFFICER_REVIEW = 'OFFICER_REVIEW',
  CORRECTIONS_IN_PROGRESS = 'CORRECTIONS_IN_PROGRESS',
  OVERRIDE_PENDING = 'OVERRIDE_PENDING',
  OVERRIDE_APPROVED = 'OVERRIDE_APPROVED',
  READY_FOR_SUBMISSION = 'READY_FOR_SUBMISSION',
  SUBMITTED = 'SUBMITTED',
}

export enum ClaimType {
  OUTPATIENT = 'OUTPATIENT',
  INPATIENT = 'INPATIENT',
  MATERNITY = 'MATERNITY',
  DENTAL = 'DENTAL',
  OPTICAL = 'OPTICAL',
  MENTAL_HEALTH = 'MENTAL_HEALTH',
  RENAL = 'RENAL',
  SURGICAL = 'SURGICAL',
  EMERGENCY = 'EMERGENCY',
}

export enum VisitType {
  OP = 'OP',
  IP = 'IP',
  DAYCASE = 'DAYCASE',
  EMERGENCY = 'EMERGENCY',
}

export enum PatientDisposition {
  IMPROVED = 'IMPROVED',
  RECOVERED = 'RECOVERED',
  DAMA = 'DAMA', // Discharged Against Medical Advice
  ABSCONDED = 'ABSCONDED',
  DIED = 'DIED',
}

export enum AccommodationType {
  FEMALE_MEDICAL = 'FEMALE_MEDICAL',
  MALE_MEDICAL = 'MALE_MEDICAL',
  FEMALE_SURGICAL = 'FEMALE_SURGICAL',
  MALE_SURGICAL = 'MALE_SURGICAL',
  NBU = 'NBU',
  PSYCHIATRIC = 'PSYCHIATRIC',
  BURNS = 'BURNS',
  ICU = 'ICU',
  HDU = 'HDU',
  NICU = 'NICU',
  ISOLATION = 'ISOLATION',
  MATERNITY = 'MATERNITY',
  RENAL = 'RENAL',
}

export interface ClaimLine {
  id: string;
  claimId: string;
  lineNumber: number;
  shaServiceCode: string;
  description: string;
  icdCode: string | null;
  procedureCode: string | null;
  caseCode: string | null;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  billAmount: number | null;
  preauthNumber: string | null;
  status: string;
  validationNotes: string | null;
  createdAt: string;
}

export interface Claim {
  id: string;
  tenantId: string;
  facilityId: string;
  payerId: string | null;
  /** Denormalized payer slug/name for display; populated on joined reads. */
  payerSlug?: string | null;
  payerName?: string | null;
  patientShaId: string | null;
  patientName: string | null;
  patientNationalId: string | null;
  hmisRef: string | null;
  claimType: ClaimType;
  visitType: VisitType;
  admissionDate: string;
  dischargeDate: string | null;
  primaryDiagnosisCode: string | null;
  shaBenefitPackage: string | null;
  preauthNumber: string | null;
  accommodationType: string | null;
  patientDisposition: PatientDisposition | null;
  hospitalApprovedTotal: number | null;
  status: ClaimStatus;
  version: number;
  lastAuditSessionId: string | null;
  dedupHash: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lines?: ClaimLine[];
}

export interface ClaimSummary {
  id: string;
  status: ClaimStatus;
  version: number;
  payerId: string | null;
  payerSlug: string | null;
  claimType: ClaimType;
  visitType: VisitType;
  hmisRef: string | null;
  patientShaId: string | null;
  admissionDate: string;
  primaryDiagnosisCode: string | null;
  documentCount: number;
  lineCount: number;
  lastAuditDecision: string | null;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
}
