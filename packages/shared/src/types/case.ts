// ============================================================================
// CASE TYPES — investigation case management
// ============================================================================

export enum CaseStatus {
  OPEN = 'OPEN',
  INVESTIGATING = 'INVESTIGATING',
  ON_HOLD = 'ON_HOLD',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
  DISMISSED = 'DISMISSED',
}

export enum CasePriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/** Allowed case status transitions. CLOSED and DISMISSED are terminal. */
export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  [CaseStatus.OPEN]: [CaseStatus.INVESTIGATING, CaseStatus.DISMISSED],
  [CaseStatus.INVESTIGATING]: [CaseStatus.ON_HOLD, CaseStatus.RESOLVED, CaseStatus.DISMISSED],
  [CaseStatus.ON_HOLD]: [CaseStatus.INVESTIGATING, CaseStatus.DISMISSED],
  [CaseStatus.RESOLVED]: [CaseStatus.CLOSED, CaseStatus.INVESTIGATING],
  [CaseStatus.CLOSED]: [],
  [CaseStatus.DISMISSED]: [],
};

export function isValidCaseTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface CaseLinkedClaim {
  claimId: string;
  linkedAt: string;
}

export interface InvestigationCase {
  id: string;
  tenantId: string;
  title: string;
  description: string | null;
  status: CaseStatus;
  priority: CasePriority;
  assignedTo: string | null;
  resolution: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  linkedClaims?: CaseLinkedClaim[];
}

export interface CaseEvent {
  id: string;
  caseId: string;
  userId: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
