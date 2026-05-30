// ============================================================================
// PREAUTHORIZATION TYPES -- Section 31 (Preauthorization Validation)
// ============================================================================

export enum PreauthorizationStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  USED = 'USED',
}

export interface PreauthorizationServiceCode {
  shaServiceCode: string;
  quantityAuthorized: number | null;
  maxAmountKes: number | null;
}

export interface PreauthorizationRecord {
  id: string;
  tenantId: string;
  facilityId: string;
  preauthNumber: string;
  patientShaId: string;
  status: PreauthorizationStatus;
  validFrom: string | null;
  validTo: string;
  approvedAt: string | null;
  source: string;
  metadata: Record<string, unknown>;
  serviceCodes: PreauthorizationServiceCode[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreauthorizationClaimValidation {
  claimId: string;
  preauthNumber: string | null;
  recordFound: boolean;
  status: PreauthorizationStatus | null;
  patientMatches: boolean;
  facilityMatches: boolean;
  notExpired: boolean;
  missingServiceCodes: string[];
  overallValid: boolean;
  reasons: string[];
}
