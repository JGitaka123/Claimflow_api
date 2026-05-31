import { describe, expect, it } from 'vitest';
import { CaseStatus, isValidCaseTransition } from '@claimflow/shared';

describe('isValidCaseTransition', () => {
  it('allows the documented forward transitions', () => {
    expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.INVESTIGATING)).toBe(true);
    expect(isValidCaseTransition(CaseStatus.INVESTIGATING, CaseStatus.RESOLVED)).toBe(true);
    expect(isValidCaseTransition(CaseStatus.RESOLVED, CaseStatus.CLOSED)).toBe(true);
    expect(isValidCaseTransition(CaseStatus.INVESTIGATING, CaseStatus.ON_HOLD)).toBe(true);
    expect(isValidCaseTransition(CaseStatus.ON_HOLD, CaseStatus.INVESTIGATING)).toBe(true);
  });

  it('allows reopening a resolved case but not a closed one', () => {
    expect(isValidCaseTransition(CaseStatus.RESOLVED, CaseStatus.INVESTIGATING)).toBe(true);
    expect(isValidCaseTransition(CaseStatus.CLOSED, CaseStatus.INVESTIGATING)).toBe(false);
  });

  it('treats CLOSED and DISMISSED as terminal', () => {
    expect(isValidCaseTransition(CaseStatus.CLOSED, CaseStatus.OPEN)).toBe(false);
    expect(isValidCaseTransition(CaseStatus.DISMISSED, CaseStatus.OPEN)).toBe(false);
  });

  it('rejects skipping straight from OPEN to RESOLVED', () => {
    expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.RESOLVED)).toBe(false);
    expect(isValidCaseTransition(CaseStatus.OPEN, CaseStatus.CLOSED)).toBe(false);
  });
});
