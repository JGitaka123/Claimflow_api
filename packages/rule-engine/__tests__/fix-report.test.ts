import { AuditDecision, RuleCategory, RuleResultStatus, RuleSeverity } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { generateFixReport } from '../src/fix-report.js';
import type { RuleEngineOutput } from '../src/types.js';
import { createRuleInput } from './helpers/test-data.js';

describe('generateFixReport', () => {
  it('renders expected markdown sections and rule entries', () => {
    const input = createRuleInput();

    const output: RuleEngineOutput = {
      decision: AuditDecision.FAILED,
      totalRules: 3,
      executionTimeMs: 12,
      rulepackVersion: '1.0.0',
      fixReportMarkdown: '',
      results: [
        {
          ruleId: 'IDN-001',
          category: RuleCategory.IDENTITY,
          severity: RuleSeverity.HARD_STOP,
          result: RuleResultStatus.FAIL,
          message: 'Patient SHA ID missing',
          remediation: 'Capture SHA ID',
          evidence: { field: 'patient_sha_id', expected: 'non-empty', actual: 'missing' },
          executionTimeMs: 2,
        },
        {
          ruleId: 'IDN-004',
          category: RuleCategory.IDENTITY,
          severity: RuleSeverity.MAJOR,
          result: RuleResultStatus.WARNING,
          message: 'Patient name mismatch',
          remediation: 'Confirm patient name',
          evidence: null,
          executionTimeMs: 2,
        },
        {
          ruleId: 'IDN-015',
          category: RuleCategory.IDENTITY,
          severity: RuleSeverity.MINOR,
          result: RuleResultStatus.PASS,
          message: 'Patient contact present',
          remediation: 'No action required',
          evidence: null,
          executionTimeMs: 2,
        },
      ],
    };

    const markdown = generateFixReport(output, input.claim, 'en');

    expect(markdown).toContain('# Claim Audit Report');
    expect(markdown).toContain('## Critical Issues (Must Fix)');
    expect(markdown).toContain('## Warnings (Should Fix)');
    expect(markdown).toContain('## Suggested Fixes');
    expect(markdown).toContain('## Passed Rules');
    expect(markdown).toContain('IDN-001');
    expect(markdown).toContain('IDN-004');
    expect(markdown).toContain('IDN-015');
  });
});

