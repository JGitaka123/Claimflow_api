import {
  AuditDecision,
  RULE_CATEGORY_ORDER,
  RuleResultStatus,
  RuleSeverity,
  type Rulepack,
} from '@claimflow/shared';
import { generateFixReport } from './fix-report.js';
import { getRuleLogic } from './registry.js';
import type { EvaluatedRuleResult, RuleEngineInput, RuleEngineOutput } from './types.js';

export function evaluate(input: RuleEngineInput, rulepack: Rulepack, locale: string): RuleEngineOutput {
  const startedAt = process.hrtime.bigint();
  const results: EvaluatedRuleResult[] = [];

  for (const category of RULE_CATEGORY_ORDER) {
    const categoryRules = rulepack.rulesByCategory.get(category) ?? [];

    for (const rule of categoryRules) {
      const ruleStart = process.hrtime.bigint();

      if (!rule.is_active) {
        results.push({
          ruleId: rule.rule_id,
          category: rule.category,
          severity: rule.severity,
          result: RuleResultStatus.SKIPPED,
          message: resolveLocalizedText(rule.message_i18n, locale),
          remediation: resolveLocalizedText(rule.remediation_i18n, locale),
          evidence: { reason: 'rule_inactive' },
          executionTimeMs: elapsedMs(ruleStart),
        });

        continue;
      }

      if (!isRuleApplicable(rule.applies_to, input.claim.claimType)) {
        results.push({
          ruleId: rule.rule_id,
          category: rule.category,
          severity: rule.severity,
          result: RuleResultStatus.SKIPPED,
          message: resolveLocalizedText(rule.message_i18n, locale),
          remediation: resolveLocalizedText(rule.remediation_i18n, locale),
          evidence: { reason: 'not_applicable' },
          executionTimeMs: elapsedMs(ruleStart),
        });

        continue;
      }

      const logicFn = getRuleLogic(rule.logic_key);

      if (!logicFn) {
        results.push({
          ruleId: rule.rule_id,
          category: rule.category,
          severity: rule.severity,
          result: RuleResultStatus.INCOMPLETE,
          message: resolveLocalizedText(rule.message_i18n, locale),
          remediation: resolveLocalizedText(rule.remediation_i18n, locale),
          evidence: {
            reason: `missing_logic_key:${rule.logic_key}`,
          },
          executionTimeMs: elapsedMs(ruleStart),
        });

        continue;
      }

      try {
        const logicResult = logicFn(input, rule.params);
        const resultStatus = normalizeResultStatus(logicResult.result);

        results.push({
          ruleId: rule.rule_id,
          category: rule.category,
          severity: rule.severity,
          result: resultStatus,
          message: resolveLocalizedText(rule.message_i18n, locale),
          remediation: resolveLocalizedText(rule.remediation_i18n, locale),
          evidence: logicResult.evidence ?? null,
          executionTimeMs: elapsedMs(ruleStart),
        });
      } catch (error) {
        results.push({
          ruleId: rule.rule_id,
          category: rule.category,
          severity: rule.severity,
          result: RuleResultStatus.INCOMPLETE,
          message: resolveLocalizedText(rule.message_i18n, locale),
          remediation: resolveLocalizedText(rule.remediation_i18n, locale),
          evidence: {
            reason: error instanceof Error ? `execution_error:${error.message}` : 'execution_error',
          },
          executionTimeMs: elapsedMs(ruleStart),
        });
      }
    }
  }

  const decision = computeDecision(results);
  const totalRules = results.filter((result) => result.result !== RuleResultStatus.SKIPPED).length;
  const executionTimeMs = elapsedMs(startedAt);

  const output: RuleEngineOutput = {
    decision,
    totalRules,
    results,
    fixReportMarkdown: '',
    executionTimeMs,
    rulepackVersion: rulepack.manifest.version,
  };

  output.fixReportMarkdown = generateFixReport(output, input.claim, locale);

  return output;
}

function computeDecision(results: EvaluatedRuleResult[]): RuleEngineOutput['decision'] {
  const hasHardStopFailure = results.some(
    (result) => result.result === RuleResultStatus.FAIL && result.severity === RuleSeverity.HARD_STOP,
  );

  if (hasHardStopFailure) {
    return AuditDecision.FAILED;
  }

  const hasWarningSignal = results.some((result) => {
    if (result.result === RuleResultStatus.WARNING) {
      return true;
    }

    if (result.result === RuleResultStatus.INCOMPLETE) {
      return true;
    }

    return result.result === RuleResultStatus.FAIL;
  });

  return hasWarningSignal ? AuditDecision.WARNING : AuditDecision.PASSED;
}

function normalizeResultStatus(status: RuleResultStatus): RuleResultStatus {
  if (Object.values(RuleResultStatus).includes(status)) {
    return status;
  }

  return RuleResultStatus.INCOMPLETE;
}

function isRuleApplicable(appliesTo: string[], claimType: string): boolean {
  return appliesTo.includes('ALL') || appliesTo.includes(claimType);
}

function resolveLocalizedText(translations: Record<string, string>, locale: string): string {
  if (translations[locale]) {
    return translations[locale];
  }

  if (translations.en) {
    return translations.en;
  }

  const firstEntry = Object.values(translations)[0];
  return firstEntry ?? '';
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

