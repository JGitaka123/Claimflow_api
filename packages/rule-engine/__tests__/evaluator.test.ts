import { RuleCategory, RuleResultStatus, RuleSeverity } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluator.js';
import { registerRule } from '../src/registry.js';
import { createRule, createRuleInput, createRulepack } from './helpers/test-data.js';

describe('evaluate', () => {
  it('returns PASSED when all applicable rules pass', () => {
    registerRule('test.pass.1', () => ({ result: RuleResultStatus.PASS }));
    registerRule('test.pass.2', () => ({ result: RuleResultStatus.PASS }));

    const rulepack = createRulepack([
      createRule({
        rule_id: 'IDN-001',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.HARD_STOP,
        logic_key: 'test.pass.1',
        sort_order: 1,
      }),
      createRule({
        rule_id: 'DOC-001',
        category: RuleCategory.DOCUMENTATION,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.pass.2',
        sort_order: 1,
      }),
    ]);

    const output = evaluate(createRuleInput(), rulepack, 'en');

    expect(output.decision).toBe('PASSED');
    expect(output.totalRules).toBe(2);
    expect(output.results.every((result) => result.result === RuleResultStatus.PASS)).toBe(true);
  });

  it('returns FAILED when any HARD_STOP rule fails and still evaluates all rules', () => {
    registerRule('test.fail.hard-stop', () => ({ result: RuleResultStatus.FAIL }));
    registerRule('test.warn.next', () => ({ result: RuleResultStatus.WARNING }));

    const rulepack = createRulepack([
      createRule({
        rule_id: 'IDN-001',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.HARD_STOP,
        logic_key: 'test.fail.hard-stop',
        sort_order: 1,
      }),
      createRule({
        rule_id: 'DOC-001',
        category: RuleCategory.DOCUMENTATION,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.warn.next',
        sort_order: 1,
      }),
    ]);

    const output = evaluate(createRuleInput(), rulepack, 'en');

    expect(output.decision).toBe('FAILED');
    expect(output.results).toHaveLength(2);
    expect(output.results[0]?.ruleId).toBe('IDN-001');
    expect(output.results[1]?.ruleId).toBe('DOC-001');
  });

  it('returns WARNING when warnings exist and no hard-stop failures exist', () => {
    registerRule('test.warning.only', () => ({ result: RuleResultStatus.WARNING }));

    const rulepack = createRulepack([
      createRule({
        rule_id: 'IDN-004',
        category: RuleCategory.IDENTITY,
        severity: RuleSeverity.MAJOR,
        logic_key: 'test.warning.only',
      }),
    ]);

    const output = evaluate(createRuleInput(), rulepack, 'en');

    expect(output.decision).toBe('WARNING');
    expect(output.results[0]?.result).toBe(RuleResultStatus.WARNING);
  });

  it('resolves localized rule text for en and sw locales', () => {
    registerRule('test.locale', () => ({ result: RuleResultStatus.PASS }));

    const localizedRule = createRule({
      rule_id: 'IDN-015',
      category: RuleCategory.IDENTITY,
      severity: RuleSeverity.MINOR,
      logic_key: 'test.locale',
      message_i18n: {
        en: 'Patient contact should be present',
        sw: 'Mawasiliano ya mgonjwa yanapaswa kuwepo',
      },
      remediation_i18n: {
        en: 'Collect contact details',
        sw: 'Kusanya taarifa za mawasiliano',
      },
    });

    const rulepack = createRulepack([localizedRule]);
    const input = createRuleInput();

    const english = evaluate(input, rulepack, 'en');
    const swahili = evaluate(input, rulepack, 'sw');

    expect(english.results[0]?.message).toBe('Patient contact should be present');
    expect(swahili.results[0]?.message).toBe('Mawasiliano ya mgonjwa yanapaswa kuwepo');
  });
});
