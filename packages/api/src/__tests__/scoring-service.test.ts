import { describe, expect, it } from 'vitest';
import {
  AuditDecision,
  ClaimType,
  DomainError,
  RecommendedAction,
  RiskLevel,
  RuleCategory,
  RuleResultStatus,
  RuleSeverity,
  VisitType,
  type ScoreClaimInput,
} from '@claimflow/shared';
import { mapFhirClaimToCreateInput, mapAuditToScoreResult } from '../services/scoring-service.js';
import type { AuditSessionResult } from '../workflows/audit-pipeline.js';

const FACILITY_ID = '11111111-1111-1111-1111-111111111111';

function fhirInput(overrides: Partial<ScoreClaimInput['claim']> = {}): ScoreClaimInput {
  return {
    facilityId: FACILITY_ID,
    claim: {
      resourceType: 'Claim',
      patient: { identifier: { value: 'CR123456789-1' }, display: 'Jane Doe' },
      type: { coding: [{ code: 'INPATIENT' }] },
      billablePeriod: { start: '2026-03-05T08:00:00Z', end: '2026-03-07' },
      diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { coding: [{ code: 'GB61' }] } }],
      item: [
        {
          sequence: 1,
          productOrService: { coding: [{ code: 'SVC-1' }], text: 'Consultation' },
          quantity: { value: 2 },
          unitPrice: { value: 500 },
        },
      ],
      ...overrides,
    },
  };
}

describe('mapFhirClaimToCreateInput', () => {
  it('maps a FHIR Claim subset to CreateClaimInput', () => {
    const result = mapFhirClaimToCreateInput(fhirInput());

    expect(result.facilityId).toBe(FACILITY_ID);
    expect(result.claimType).toBe(ClaimType.INPATIENT);
    expect(result.visitType).toBe(VisitType.OP);
    expect(result.admissionDate).toBe('2026-03-05');
    expect(result.dischargeDate).toBe('2026-03-07');
    expect(result.patientShaId).toBe('CR123456789-1');
    expect(result.patientName).toBe('Jane Doe');
    expect(result.primaryDiagnosisCode).toBe('GB61');
    expect(result.lines).toEqual([
      { shaServiceCode: 'SVC-1', description: 'Consultation', quantity: 2, unitPrice: 500 },
    ]);
  });

  it('defaults an unknown claim type to OUTPATIENT', () => {
    const result = mapFhirClaimToCreateInput(fhirInput({ type: { coding: [{ code: 'professional' }] } }));
    expect(result.claimType).toBe(ClaimType.OUTPATIENT);
  });

  it('derives unit price from net when unitPrice is absent', () => {
    const result = mapFhirClaimToCreateInput(
      fhirInput({
        item: [{ productOrService: { text: 'Ward' }, quantity: { value: 4 }, net: { value: 2000 } }],
      }),
    );
    expect(result.lines?.[0]?.unitPrice).toBe(500);
    expect(result.lines?.[0]?.shaServiceCode).toBe('UNKNOWN');
  });

  it('throws VALIDATION_ERROR when billablePeriod.start is missing', () => {
    const input = fhirInput();
    delete (input.claim as { billablePeriod?: unknown }).billablePeriod;
    expect(() => mapFhirClaimToCreateInput(input)).toThrow(DomainError);
  });
});

function auditResult(overrides: Partial<AuditSessionResult['auditSession']> = {}): AuditSessionResult {
  return {
    auditSession: {
      id: 'audit-1',
      claimId: 'claim-1',
      userId: 'user-1',
      rulepackVersion: '1.0.0',
      rulepackChecksum: 'abc',
      payerId: 'payer-1',
      payerSlug: 'sha',
      decision: AuditDecision.FAILED,
      totalRules: 4,
      passedCount: 1,
      failedCount: 1,
      warningCount: 1,
      incompleteCount: 1,
      skippedCount: 0,
      deterministicScore: 0.5,
      mlQualityScore: null,
      fixReportMd: null,
      executionTimeMs: 10,
      startedAt: '2026-03-05T08:00:00.000Z',
      completedAt: '2026-03-05T08:00:01.000Z',
      ...overrides,
    },
    ruleResults: [
      { id: 'r1', ruleId: 'IDN-001', category: RuleCategory.IDENTITY, severity: RuleSeverity.HARD_STOP, result: RuleResultStatus.FAIL, message: 'Missing SHA ID', remediation: null, evidence: null, executionTimeMs: 1, createdAt: '2026-03-05T08:00:00.000Z' },
      { id: 'r2', ruleId: 'DOC-003', category: RuleCategory.DOCUMENTATION, severity: RuleSeverity.MAJOR, result: RuleResultStatus.WARNING, message: 'Document quality low', remediation: null, evidence: null, executionTimeMs: 1, createdAt: '2026-03-05T08:00:00.000Z' },
      { id: 'r3', ruleId: 'DOC-009', category: RuleCategory.DOCUMENTATION, severity: RuleSeverity.MINOR, result: RuleResultStatus.INCOMPLETE, message: 'No document provided', remediation: null, evidence: null, executionTimeMs: 1, createdAt: '2026-03-05T08:00:00.000Z' },
      { id: 'r4', ruleId: 'FIN-001', category: RuleCategory.FINANCIAL, severity: RuleSeverity.MAJOR, result: RuleResultStatus.PASS, message: 'Tariff ok', remediation: null, evidence: null, executionTimeMs: 1, createdAt: '2026-03-05T08:00:00.000Z' },
    ],
  };
}

describe('mapAuditToScoreResult', () => {
  it('produces a public-safe score result with reason codes and no internals', () => {
    const result = mapAuditToScoreResult(
      { id: 'claim-1', payerSlug: 'sha', payerName: 'Social Health Authority' },
      auditResult(),
    );

    expect(result.claimId).toBe('claim-1');
    expect(result.auditId).toBe('audit-1');
    expect(result.payer).toEqual({ slug: 'sha', name: 'Social Health Authority' });
    expect(result.decision).toBe(AuditDecision.FAILED);
    expect(result.riskScore).toBe(50);
    expect(result.riskLevel).toBe(RiskLevel.HIGH);
    // A HARD_STOP failure escalates the recommended action to DO_NOT_SUBMIT.
    expect(result.recommendedAction).toBe(RecommendedAction.DO_NOT_SUBMIT);
    expect(result.counts).toEqual({ failed: 1, warning: 1, incomplete: 1, passed: 1 });

    // PASS results are not surfaced as flags; FAIL/WARNING/INCOMPLETE are.
    expect(result.flags).toHaveLength(3);
    expect(result.flags[0]).toEqual({
      reasonCode: 'CF-IDN-001',
      category: RuleCategory.IDENTITY,
      severity: RuleSeverity.HARD_STOP,
      message: 'Missing SHA ID',
      auditorGeneralTypology: null,
    });

    // Integrity: no rule internals leak into the serialized public result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('evidence');
    expect(serialized).not.toContain('logicKey');
    expect(serialized).not.toContain('checksum');
    expect(serialized).not.toContain('rulepackVersion');
  });

  it('recommends FIX_REQUIRED for a failure without a hard stop', () => {
    const audit = auditResult();
    audit.ruleResults = audit.ruleResults.map((r) =>
      r.severity === RuleSeverity.HARD_STOP ? { ...r, severity: RuleSeverity.MAJOR } : r,
    );

    const result = mapAuditToScoreResult({ id: 'claim-1' }, audit);
    expect(result.recommendedAction).toBe(RecommendedAction.FIX_REQUIRED);
  });

  it('recommends READY_FOR_SUBMISSION when passed', () => {
    const result = mapAuditToScoreResult(
      { id: 'claim-1' },
      auditResult({ decision: AuditDecision.PASSED, deterministicScore: 1, failedCount: 0, warningCount: 0, incompleteCount: 0, passedCount: 4 }),
    );

    expect(result.decision).toBe(AuditDecision.PASSED);
    expect(result.riskScore).toBe(0);
    expect(result.riskLevel).toBe(RiskLevel.LOW);
    expect(result.recommendedAction).toBe(RecommendedAction.READY_FOR_SUBMISSION);
  });
});
