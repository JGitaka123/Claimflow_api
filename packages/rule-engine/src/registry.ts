import { RuleResultStatus } from '@claimflow/shared';
import { authorizationRuleLogicRegistry } from './rules/authorization.js';
import { clinicalRuleLogicRegistry } from './rules/clinical.js';
import { documentationRuleLogicRegistry } from './rules/documentation.js';
import { financialRuleLogicRegistry } from './rules/financial.js';
import { identityRuleLogicRegistry } from './rules/identity.js';
import { structuralRuleLogicRegistry } from './rules/structural.js';
import type { RuleLogicFn } from './types.js';

const alwaysPass: RuleLogicFn = () => ({ result: RuleResultStatus.PASS });

export const ruleLogicRegistry: Record<string, RuleLogicFn> = {
  ...identityRuleLogicRegistry,
  ...documentationRuleLogicRegistry,
  ...clinicalRuleLogicRegistry,
  ...authorizationRuleLogicRegistry,
  ...financialRuleLogicRegistry,
  ...structuralRuleLogicRegistry,
  placeholder_rule_logic: alwaysPass,
};

export function registerRule(logicKey: string, fn: RuleLogicFn): void {
  const normalizedKey = logicKey.trim();

  if (normalizedKey.length === 0) {
    throw new Error('logicKey must be a non-empty string');
  }

  ruleLogicRegistry[normalizedKey] = fn;
}

export function getRuleLogic(logicKey: string): RuleLogicFn | undefined {
  return ruleLogicRegistry[logicKey];
}
