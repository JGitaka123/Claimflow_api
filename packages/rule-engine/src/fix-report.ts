import {
  AuditDecision,
  RuleResultStatus,
  RuleSeverity,
} from '@claimflow/shared';
import type { ClaimSnapshot, RuleEngineOutput } from './types.js';

export function generateFixReport(
  output: RuleEngineOutput,
  claim: ClaimSnapshot,
  _locale: string,
): string {
  const nowIso = new Date().toISOString();
  const facilityLabel = claim.facilityId;

  const hardStopFailures = output.results.filter(
    (result) => result.result === RuleResultStatus.FAIL && result.severity === RuleSeverity.HARD_STOP,
  );

  const warnings = output.results.filter((result) => {
    if (result.result === RuleResultStatus.WARNING) {
      return true;
    }

    if (result.result === RuleResultStatus.INCOMPLETE) {
      return true;
    }

    return result.result === RuleResultStatus.FAIL && result.severity !== RuleSeverity.HARD_STOP;
  });

  const passed = output.results.filter((result) => result.result === RuleResultStatus.PASS);

  const suggestedFixes = Array.from(
    new Set(
      [...hardStopFailures, ...warnings]
        .map((result) => result.remediation)
        .filter((remediation): remediation is string => typeof remediation === 'string' && remediation.length > 0),
    ),
  );

  const lines: string[] = [
    '# Claim Audit Report',
    `**Claim ID:** ${claim.id}`,
    `**Facility:** ${facilityLabel}`,
    `**Date:** ${nowIso}`,
    `**Rulepack:** v${output.rulepackVersion ?? 'unknown'}`,
    `**Decision:** ${formatDecision(output.decision)}`,
    '',
    '## Summary',
    `- Rules Executed: ${output.totalRules}`,
    `- Passed: ${passed.length} | Failed: ${hardStopFailures.length} | Warnings: ${warnings.length}`,
    '',
    '## Critical Issues (Must Fix)',
  ];

  if (hardStopFailures.length === 0) {
    lines.push('- None');
  } else {
    for (const rule of hardStopFailures) {
      lines.push(`### [CRITICAL] ${rule.ruleId}: ${rule.message}`);
      lines.push(`**Category:** ${rule.category}`);
      lines.push(`**How to fix:** ${rule.remediation ?? 'No remediation provided'}`);

      if (rule.evidence) {
        lines.push(`**Evidence:** ${formatEvidence(rule.evidence)}`);
      }

      lines.push('');
    }
  }

  lines.push('## Warnings (Should Fix)');

  if (warnings.length === 0) {
    lines.push('- None');
  } else {
    for (const rule of warnings) {
      lines.push(`### [WARNING] ${rule.ruleId}: ${rule.message}`);
      lines.push(`**How to fix:** ${rule.remediation ?? 'No remediation provided'}`);

      if (rule.evidence) {
        lines.push(`**Evidence:** ${formatEvidence(rule.evidence)}`);
      }

      lines.push('');
    }
  }

  lines.push('## Suggested Fixes');

  if (suggestedFixes.length === 0) {
    lines.push('- No additional fixes suggested');
  } else {
    for (const suggestedFix of suggestedFixes) {
      lines.push(`- ${suggestedFix}`);
    }
  }

  lines.push('', '## Passed Rules');

  if (passed.length === 0) {
    lines.push('- None');
  } else {
    for (const rule of passed) {
      lines.push(`- [PASS] ${rule.ruleId}: ${rule.message}`);
    }
  }

  return lines.join('\n').trimEnd();
}

function formatEvidence(evidence: NonNullable<RuleEngineOutput['results'][number]['evidence']>): string {
  const parts: string[] = [];

  if (evidence.documentId) {
    parts.push(`Document ${evidence.documentId}`);
  }

  if (typeof evidence.page === 'number') {
    parts.push(`Page ${evidence.page}`);
  }

  if (evidence.field) {
    parts.push(`Field ${evidence.field}`);
  }

  if (evidence.actual) {
    parts.push(`Actual '${evidence.actual}'`);
  }

  if (evidence.expected) {
    parts.push(`Expected '${evidence.expected}'`);
  }

  if (evidence.reason) {
    parts.push(`Reason ${evidence.reason}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'No structured evidence provided';
}

function formatDecision(decision: AuditDecision): string {
  switch (decision) {
    case AuditDecision.FAILED:
      return 'FAILED';
    case AuditDecision.WARNING:
      return 'WARNING';
    default:
      return 'PASSED';
  }
}

