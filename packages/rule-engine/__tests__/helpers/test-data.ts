import {
  ClaimType,
  RuleCategory,
  RuleSeverity,
  type Rulepack,
  type RulepackRule,
} from '@claimflow/shared';
import type { RuleEngineInput } from '../../src/types.js';

export function createRuleInput(overrides: Partial<RuleEngineInput> = {}): RuleEngineInput {
  return {
    claim: {
      id: 'claim-1',
      claimType: ClaimType.OUTPATIENT,
      tenantId: 'tenant-1',
      facilityId: 'facility-1',
      admissionDate: '2026-03-05',
      patientShaId: 'CR123456789-1',
    },
    extractedFields: new Map(),
    documents: [],
    facilityContext: {
      facilityId: 'facility-1',
      facilityCode: 'FID-22-106718-4',
      facilityTier: 'LEVEL_4',
    },
    tariffs: {
      byServiceCode: {},
    },
    registryResults: {
      available: true,
    },
    ...overrides,
  };
}

interface RuleDefinition {
  rule_id: string;
  category?: RuleCategory;
  severity?: RuleSeverity;
  logic_key?: string;
  applies_to?: string[];
  message_i18n?: Record<string, string>;
  remediation_i18n?: Record<string, string>;
  sort_order?: number;
  is_active?: boolean;
  params?: Record<string, unknown>;
}

export function createRule(rule: RuleDefinition): RulepackRule {
  return {
    rule_id: rule.rule_id,
    category: rule.category ?? RuleCategory.IDENTITY,
    severity: rule.severity ?? RuleSeverity.HARD_STOP,
    logic_key: rule.logic_key ?? 'test.always-pass',
    applies_to: rule.applies_to ?? ['ALL'],
    params: rule.params ?? {},
    message_i18n: rule.message_i18n ?? { en: `${rule.rule_id} message`, sw: `${rule.rule_id} ujumbe` },
    remediation_i18n:
      rule.remediation_i18n ?? { en: `${rule.rule_id} remediation`, sw: `${rule.rule_id} marekebisho` },
    is_active: rule.is_active ?? true,
    sort_order: rule.sort_order ?? 1,
  };
}

export function createRulepack(rules: RulepackRule[], version = 'test-1.0.0'): Rulepack {
  const categories = Object.values(RuleCategory) as RuleCategory[];
  const rulesByCategory = new Map<RuleCategory, RulepackRule[]>(
    categories.map((category) => [category, []]),
  );

  for (const rule of rules) {
    const grouped = rulesByCategory.get(rule.category);

    if (!grouped) {
      throw new Error(`Unknown category ${rule.category}`);
    }

    grouped.push(rule);
  }

  const ruleById = new Map<string, RulepackRule>(rules.map((rule) => [rule.rule_id, rule]));

  return {
    manifest: {
      version,
      sha_policy_version: 'LN-56-2025',
      description: 'Test rulepack',
      rule_count: rules.length,
      checksum: '',
    },
    rules,
    rulesByCategory,
    ruleById,
  };
}




