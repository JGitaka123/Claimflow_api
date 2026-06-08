// ============================================================================
// RULE ENGINE TYPES — Section 11 (Rule Engine) + Section 12 (Rule Catalog)
// ============================================================================

export enum RuleSeverity {
  HARD_STOP = 'HARD_STOP',
  MAJOR = 'MAJOR',
  MINOR = 'MINOR',
  INFO = 'INFO',
}

export enum RuleCategory {
  IDENTITY = 'IDENTITY',
  DOCUMENTATION = 'DOCUMENTATION',
  CLINICAL = 'CLINICAL',
  AUTHORIZATION = 'AUTHORIZATION',
  FINANCIAL = 'FINANCIAL',
  STRUCTURAL = 'STRUCTURAL',
}

/** Order of category execution in the rule engine */
export const RULE_CATEGORY_ORDER: RuleCategory[] = [
  RuleCategory.IDENTITY,
  RuleCategory.DOCUMENTATION,
  RuleCategory.CLINICAL,
  RuleCategory.AUTHORIZATION,
  RuleCategory.FINANCIAL,
  RuleCategory.STRUCTURAL,
];

export enum RuleResultStatus {
  PASS = 'PASS',
  FAIL = 'FAIL',
  WARNING = 'WARNING',
  INCOMPLETE = 'INCOMPLETE',
  SKIPPED = 'SKIPPED',
}

export enum AuditDecision {
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  WARNING = 'WARNING',
}

export interface RuleEvidence {
  documentId?: string;
  page?: number;
  field?: string;
  expected?: string;
  actual?: string;
  bbox?: { x: number; y: number; w: number; h: number };
  reason?: string;
}

export interface RuleResult {
  ruleId: string;
  category: RuleCategory;
  severity: RuleSeverity;
  result: RuleResultStatus;
  message: string;
  remediation: string | null;
  evidence: RuleEvidence | null;
  executionTimeMs?: number;
}

export interface AuditSession {
  id: string;
  claimId: string;
  userId: string;
  rupackVersion: string;
  rupackChecksum: string;
  decision: AuditDecision | null;
  totalRules: number;
  passedCount: number;
  failedCount: number;
  warningCount: number;
  incompleteCount: number;
  skippedCount: number;
  deterministicScore: number | null;
  mlQualityScore: number | null;
  fixReportMd: string | null;
  fixReportPdfPath: string | null;
  executionTimeMs: number | null;
  isBatch: boolean;
  batchJobId: string | null;
  startedAt: string;
  completedAt: string | null;
  ruleResults?: RuleResult[];
}

export interface RulepackManifest {
  version: string;
  sha_policy_version: string;
  description: string;
  rule_count: number;
  checksum: string;
}

export interface RulepackRule {
  rule_id: string;
  category: RuleCategory;
  severity: RuleSeverity;
  logic_key: string;
  params: Record<string, unknown>;
  applies_to: string[]; // ClaimType[] or ["ALL"]
  message_i18n: Record<string, string>;
  remediation_i18n: Record<string, string>;
  is_active: boolean;
  sort_order: number;
}

export interface Rulepack {
  manifest: RulepackManifest;
  rules: RulepackRule[];
  rulesByCategory: Map<RuleCategory, RulepackRule[]>;
  ruleById: Map<string, RulepackRule>;
}

// ============================================================================
// AUDIT VIEW — the single customer-facing audit representation (PR-B)
// ----------------------------------------------------------------------------
// AuditSummary is the ONLY audit representation the API serves. It exposes
// per-finding claim-level justification a customer needs to action a flag —
// reason codes, category, severity, public message, remediation guidance, and
// `evidence` (which field / document page a flag points at, used by the
// dashboard to jump-to-field). It deliberately OMITS the three SYSTEM INTERNALS
// — `deterministicScore`, `mlQualityScore`, `fixReportMd` — which are detection
// IP and are never rendered by any UI; they stay in the engine / DB / logs and
// never leave the server over the API.
//
// Access is gated by the `audit:read` permission, which is NOT in the machine
// scope vocabulary — so API keys / OAuth clients (external integrators) cannot
// reach these endpoints at all, and `evidence` (PHI-adjacent) never reaches a
// machine credential.
// ============================================================================

/**
 * A single audit finding. Public-safe: carries claim-level justification
 * (message, remediation, evidence) but NEVER system internals (scores / fix
 * report). `evidence` points at the claim field / document location a flag
 * concerns; it is served only to human tenant staff via the audit:read gate.
 */
export interface AuditSummaryFinding {
  ruleId: string;
  category: RuleCategory;
  severity: RuleSeverity;
  result: RuleResultStatus;
  /** Short public message — no thresholds, params, or scores. */
  message: string;
  /** Staff fix-guidance for this finding (not a system score). */
  remediation: string | null;
  /** Claim-level justification: which field / document location the flag concerns. */
  evidence: Record<string, unknown> | null;
  /** SHA Auditor-General typology; null until the authoritative mapping is supplied. */
  auditorGeneralTypology: string | null;
}

/** The customer-facing audit summary. Closed shape — never carries system internals. */
export interface AuditSummary {
  auditId: string;
  claimId: string;
  payer: { slug: string | null; name: string | null };
  decision: AuditDecision | null;
  totalRules: number;
  passedCount: number;
  failedCount: number;
  warningCount: number;
  incompleteCount: number;
  skippedCount: number;
  rulepackVersion: string;
  startedAt: string;
  completedAt: string | null;
  findings: AuditSummaryFinding[];
}
