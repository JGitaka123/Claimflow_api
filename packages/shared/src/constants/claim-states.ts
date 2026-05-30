// ============================================================================
// CLAIM STATE MACHINE — Section 8
// ============================================================================

import { ClaimStatus } from '../types/claim.js';

/**
 * Valid state transitions.
 * Key = current state, Value = array of allowed target states.
 */
export const VALID_TRANSITIONS: ReadonlyMap<ClaimStatus, readonly ClaimStatus[]> = new Map([
  [ClaimStatus.DRAFT, [ClaimStatus.DOCUMENTS_UPLOADED]],
  [ClaimStatus.DOCUMENTS_UPLOADED, [ClaimStatus.PROCESSING]],
  [ClaimStatus.PROCESSING, [ClaimStatus.AUDIT_COMPLETE]],
  // AUDIT_COMPLETE is transient — system auto-transitions based on audit result
  [ClaimStatus.AUDIT_COMPLETE, [ClaimStatus.PASSED, ClaimStatus.FAILED, ClaimStatus.WARNING]],
  [ClaimStatus.PASSED, [ClaimStatus.READY_FOR_SUBMISSION]], // v2+
  [ClaimStatus.WARNING, [ClaimStatus.OFFICER_REVIEW]],
  [ClaimStatus.OFFICER_REVIEW, [ClaimStatus.PASSED, ClaimStatus.FAILED]],
  [ClaimStatus.FAILED, [
    ClaimStatus.CORRECTIONS_IN_PROGRESS,
    ClaimStatus.OVERRIDE_PENDING,
  ]],
  [ClaimStatus.CORRECTIONS_IN_PROGRESS, [ClaimStatus.DOCUMENTS_UPLOADED]],
  [ClaimStatus.OVERRIDE_PENDING, [ClaimStatus.OVERRIDE_APPROVED, ClaimStatus.FAILED]],
  [ClaimStatus.OVERRIDE_APPROVED, [ClaimStatus.READY_FOR_SUBMISSION]], // v2+
  [ClaimStatus.READY_FOR_SUBMISSION, [ClaimStatus.SUBMITTED]], // v2+
  [ClaimStatus.SUBMITTED, []], // Terminal state
]);

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(from: ClaimStatus, to: ClaimStatus): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Get all states a claim can transition to from its current state.
 */
export function getAvailableTransitions(current: ClaimStatus): readonly ClaimStatus[] {
  return VALID_TRANSITIONS.get(current) ?? [];
}

/**
 * States where a claim can be edited (fields updated, documents uploaded).
 */
export const EDITABLE_STATES: readonly ClaimStatus[] = [
  ClaimStatus.DRAFT,
  ClaimStatus.CORRECTIONS_IN_PROGRESS,
];

/**
 * States where an audit can be triggered.
 */
export const AUDITABLE_STATES: readonly ClaimStatus[] = [
  ClaimStatus.DOCUMENTS_UPLOADED,
];

/**
 * Terminal states — claim cannot transition further.
 */
export const TERMINAL_STATES: readonly ClaimStatus[] = [
  ClaimStatus.SUBMITTED,
];
