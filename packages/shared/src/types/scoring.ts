// ============================================================================
// SCORING TYPES — public-safe output for POST /v1/claims/score
// ============================================================================
//
// The scoring endpoint returns scores, flags, and reason codes only. It must NOT
// expose detection-rule internals (thresholds, logic keys, params, raw rule
// definitions, or evidence). Reason codes use a ClaimFlow-owned taxonomy derived
// from the deterministic rulepack; `auditorGeneralTypology` stays null until the
// authoritative SHA Auditor-General typology mapping is supplied.

import type { AuditDecision, RuleCategory, RuleSeverity } from './rule.js';

export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum RecommendedAction {
  READY_FOR_SUBMISSION = 'READY_FOR_SUBMISSION',
  REVIEW_RECOMMENDED = 'REVIEW_RECOMMENDED',
  FIX_REQUIRED = 'FIX_REQUIRED',
  DO_NOT_SUBMIT = 'DO_NOT_SUBMIT',
}

export interface ScoreFlag {
  /** ClaimFlow-owned reason code, e.g. "CF-FIN-021". */
  reasonCode: string;
  category: RuleCategory;
  severity: RuleSeverity;
  /** Short public description — no thresholds or rule internals. */
  message: string;
  /** SHA Auditor-General typology; null until the authoritative mapping is supplied. */
  auditorGeneralTypology: string | null;
}

export interface ClaimScoreCounts {
  failed: number;
  warning: number;
  incomplete: number;
  passed: number;
}

export interface ClaimScoreResult {
  claimId: string;
  auditId: string;
  payer: { slug: string | null; name: string | null };
  decision: AuditDecision | null;
  /** 0..100; higher means more documentation risk. */
  riskScore: number;
  riskLevel: RiskLevel;
  recommendedAction: RecommendedAction;
  flags: ScoreFlag[];
  counts: ClaimScoreCounts;
}
