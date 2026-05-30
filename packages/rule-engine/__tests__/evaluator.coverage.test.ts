import {
  AuditDecision,
  ClaimType,
  RuleCategory,
  RuleResultStatus,
  RuleSeverity,
} from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluator.js';
import { registerRule } from '../src/registry.js';
import { createRule, createRuleInput, createRulepack } from './helpers/test-data.js';

describe('evaluate coverage branches', () => {
  it('handles skipped/inactive/missing logic/error/invalid result and locale fallbacks', () => {
    registerRule('test.throw', () => {
      throw new Error('boom');
    });

    registerRule('test.invalid-result', () => ({ result: 'NOT_A_STATUS' as unknown as RuleResultStatus }));

    registerRule('test.pass', () => ({ result: RuleResultStatus.PASS }));

    const input = createRuleInput();
    input.claim.claimType = ClaimType.OUTPATIENT;

    const rulepack = createRulepack([
      createRule({
        rule_id: 'R-INACTIVE',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.INFO,
        logic_key: 'test.pass',
        is_active: false,
      }),
      createRule({
        rule_id: 'R-NOT-APPLICABLE',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.INFO,
        logic_key: 'test.pass',
        applies_to: [ClaimType.INPATIENT],
      }),
      createRule({
        rule_id: 'R-MISSING-LOGIC',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'missing.logic.key',
      }),
      createRule({
        rule_id: 'R-THROW',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.throw',
      }),
      createRule({
        rule_id: 'R-INVALID-STATUS',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.invalid-result',
      }),
      createRule({
        rule_id: 'R-FIRST-ENTRY-FALLBACK',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.pass',
        message_i18n: { fr: 'Bonjour' },
        remediation_i18n: { fr: 'Corriger' },
      }),
      createRule({
        rule_id: 'R-EN-FALLBACK',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.pass',
        message_i18n: { en: 'English only' },
        remediation_i18n: { en: 'Fix in English' },
      }),
      createRule({
        rule_id: 'R-HARD-FAIL',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.HARD_STOP,
        logic_key: 'test.pass',
      }),
    ]);

    registerRule('test.pass', () => ({ result: RuleResultStatus.FAIL }));

    const output = evaluate(input, rulepack, 'sw');

    expect(output.results.find((r) => r.ruleId === 'R-INACTIVE')?.result).toBe(RuleResultStatus.SKIPPED);
    expect(output.results.find((r) => r.ruleId === 'R-NOT-APPLICABLE')?.result).toBe(RuleResultStatus.SKIPPED);

    expect(output.results.find((r) => r.ruleId === 'R-MISSING-LOGIC')?.result).toBe(RuleResultStatus.INCOMPLETE);
    expect(output.results.find((r) => r.ruleId === 'R-THROW')?.result).toBe(RuleResultStatus.INCOMPLETE);
    expect(output.results.find((r) => r.ruleId === 'R-INVALID-STATUS')?.result).toBe(RuleResultStatus.INCOMPLETE);

    expect(output.results.find((r) => r.ruleId === 'R-FIRST-ENTRY-FALLBACK')?.message).toBe('Bonjour');
    expect(output.results.find((r) => r.ruleId === 'R-EN-FALLBACK')?.message).toBe('English only');

    expect(output.decision).toBe(AuditDecision.FAILED);
  });

  it('covers missing category map branch explicitly', () => {
    const input = createRuleInput();

    const fallbackRulepack = createRulepack([]);
    fallbackRulepack.rulesByCategory.delete(RuleCategory.IDENTITY);

    const emptyCategoryOutput = evaluate(input, fallbackRulepack, 'en');
    expect(emptyCategoryOutput.decision).toBe(AuditDecision.PASSED);

    const fullyMissingCategoryMap = createRulepack([]);
    fullyMissingCategoryMap.rulesByCategory = new Map();

    const missingMapOutput = evaluate(input, fullyMissingCategoryMap, 'en');
    expect(missingMapOutput.decision).toBe(AuditDecision.PASSED);
  });

  it('covers non-Error throw and empty i18n fallback branches', () => {
    registerRule('test.throw-string', () => {
      throw 'boom';
    });

    registerRule('test.pass', () => ({ result: RuleResultStatus.PASS }));

    const input = createRuleInput();
    const branchRulepack = createRulepack([
      createRule({
        rule_id: 'R-THROW-STRING',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.throw-string',
      }),
      createRule({
        rule_id: 'R-EMPTY-I18N',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MINOR,
        logic_key: 'test.pass',
        message_i18n: {} as unknown as Record<string, string>,
        remediation_i18n: {} as unknown as Record<string, string>,
      }),
    ]);

    const output = evaluate(input, branchRulepack, 'sw');
    expect(output.results.find((r) => r.ruleId === 'R-THROW-STRING')?.result).toBe(RuleResultStatus.INCOMPLETE);
    expect(output.results.find((r) => r.ruleId === 'R-THROW-STRING')?.evidence?.reason).toBe('execution_error');
    expect(output.results.find((r) => r.ruleId === 'R-EMPTY-I18N')?.message).toBe('');
  });

  it('returns WARNING when INCOMPLETE exists with no hard-stop failures', () => {
    registerRule('test.incomplete', () => ({ result: RuleResultStatus.INCOMPLETE }));

    const input = createRuleInput();
    const rulepack = createRulepack([
      createRule({
        rule_id: 'R-WARN-INCOMPLETE',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.incomplete',
      }),
    ]);

    const output = evaluate(input, rulepack, 'en');
    expect(output.decision).toBe(AuditDecision.WARNING);
  });

  it('returns PASSED when only skipped rules are present', () => {
    const input = createRuleInput();
    const rulepack = createRulepack([
      createRule({
        rule_id: 'R-SKIP',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.INFO,
        logic_key: 'missing.logic',
        is_active: false,
      }),
    ]);

    const output = evaluate(input, rulepack, 'en');
    expect(output.decision).toBe(AuditDecision.PASSED);
    expect(output.totalRules).toBe(0);
  });
});
