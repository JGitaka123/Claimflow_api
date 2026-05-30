import { ClaimType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import {
  createRuleInput,
  evaluateRule,
  makeLine,
  setClaimType,
  setField,
} from '../helpers/rule-test-helpers.js';

type FinancialRuleId =
  | 'FIN-001'
  | 'FIN-002'
  | 'FIN-003'
  | 'FIN-004'
  | 'FIN-005'
  | 'FIN-006'
  | 'FIN-007'
  | 'FIN-008'
  | 'FIN-009'
  | 'FIN-010'
  | 'FIN-011'
  | 'FIN-012'
  | 'FIN-013'
  | 'FIN-014'
  | 'FIN-015'
  | 'FIN-016'
  | 'FIN-017'
  | 'FIN-018'
  | 'FIN-019'
  | 'FIN-020'
  | 'FIN-021';

interface Scenario {
  ruleId: FinancialRuleId;
  passSetup: (input: ReturnType<typeof createRuleInput>) => void;
  failSetup: (input: ReturnType<typeof createRuleInput>) => void;
  expectedFail: RuleResultStatus;
}

function setTariff(input: ReturnType<typeof createRuleInput>, code: string, maxAmount: number, tier = 'LEVEL_4'): void {
  input.tariffs.byServiceCode = {
    ...(input.tariffs.byServiceCode ?? {}),
    [code]: [{ serviceCode: code, facilityTier: tier, maxAmount }],
  };
}

const scenarios: Scenario[] = [
  {
    ruleId: 'FIN-001',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-1' })];
      setTariff(input, 'SVC-1', 1000);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-MISSING' })];
      input.tariffs.byServiceCode = {};
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-002',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-2', quantity: 1, totalAmount: 900 })];
      setTariff(input, 'SVC-2', 1000);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-2', quantity: 1, totalAmount: 2000 })];
      setTariff(input, 'SVC-2', 1000);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-003',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-3' })];
      setTariff(input, 'SVC-3', 1000, 'LEVEL_4');
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-3' })];
      setTariff(input, 'SVC-3', 1000, 'LEVEL_5');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-004',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ quantity: 2 })];
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ quantity: 101 })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-005',
    passSetup: (input) => {
      input.claim.lines = [
        makeLine({ shaServiceCode: 'SVC-A', description: 'Service A', totalAmount: 100 }),
        makeLine({ lineNumber: 2, shaServiceCode: 'SVC-B', description: 'Service B', totalAmount: 200 }),
      ];
    },
    failSetup: (input) => {
      input.claim.lines = [
        makeLine({ shaServiceCode: 'SVC-A', description: 'Service A', totalAmount: 100 }),
        makeLine({ lineNumber: 2, shaServiceCode: 'SVC-A', description: 'Service A', totalAmount: 100 }),
        makeLine({ lineNumber: 3, shaServiceCode: 'SVC-A', description: 'Service A', totalAmount: 100 }),
        makeLine({ lineNumber: 4, shaServiceCode: 'SVC-A', description: 'Service A', totalAmount: 100 }),
      ];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-006',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SURG-1', description: 'Routine surgical procedure' })];
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'GEN-1', description: 'Specialized cardiac surgery package' })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-007',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 500 })];
      setField(input, 'claim_total_amount', 500);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 500 })];
      setField(input, 'claim_total_amount', 800);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-008',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-8', unitPrice: 400 })];
      setTariff(input, 'SVC-8', 500);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-8', unitPrice: 700 })];
      setTariff(input, 'SVC-8', 500);
    },
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'FIN-009',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Pharmacy medication', shaServiceCode: 'RX-1' })];
      setField(input, 'formulary_approved', true);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Pharmacy medication', shaServiceCode: 'RX-1' })];
      setField(input, 'formulary_approved', false);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-010',
    passSetup: (input) => {
      setField(input, 'bed_days_charged', 3);
      setField(input, 'length_of_stay_days', 3);
    },
    failSetup: (input) => {
      setField(input, 'bed_days_charged', 8);
      setField(input, 'length_of_stay_days', 3);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-011',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'CONS-1', description: 'Consultation', totalAmount: 800 })];
      setTariff(input, 'CONS-1', 1000);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'CONS-1', description: 'Consultation', totalAmount: 1500 })];
      setTariff(input, 'CONS-1', 1000);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-012',
    passSetup: (input) => {
      setClaimType(input, ClaimType.SURGICAL);
      input.claim.lines = [makeLine({ description: 'Surgery fee', procedureCode: 'PROC-1' })];
    },
    failSetup: (input) => {
      setClaimType(input, ClaimType.SURGICAL);
      input.claim.lines = [makeLine({ description: 'Surgery fee', procedureCode: null })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-013',
    passSetup: (input) => {
      input.claim.lines = [
        makeLine({ shaServiceCode: 'SVC-A', description: 'Service A' }),
        makeLine({ lineNumber: 2, shaServiceCode: 'SVC-B', description: 'Service B' }),
      ];
    },
    failSetup: (input) => {
      input.claim.lines = [
        makeLine({ shaServiceCode: 'SVC-A', description: 'Service A' }),
        makeLine({ lineNumber: 2, shaServiceCode: 'SVC-A', description: 'Service A' }),
      ];
    },
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'FIN-014',
    passSetup: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'maternity_package_rate_applied', true);
    },
    failSetup: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'maternity_package_rate_applied', false);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-015',
    passSetup: (input) => {
      setClaimType(input, ClaimType.RENAL);
      input.claim.lines = [makeLine({ shaServiceCode: 'REN-1', description: 'Dialysis', unitPrice: 1000 })];
      setTariff(input, 'REN-1', 1500);
    },
    failSetup: (input) => {
      setClaimType(input, ClaimType.RENAL);
      input.claim.lines = [makeLine({ shaServiceCode: 'REN-1', description: 'Dialysis', unitPrice: 2000 })];
      setTariff(input, 'REN-1', 1500);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-016',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 50000 })];
      setField(input, 'claim_total_amount', 50000);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 2_500_000 })];
      setField(input, 'claim_total_amount', 2_500_000);
    },
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'FIN-017',
    passSetup: (input) => {
      input.claim.accommodationType = 'ICU';
      input.claim.lines = [makeLine({ description: 'ICU bed day', shaServiceCode: 'ICU-1' })];
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'ICU bed day', shaServiceCode: 'ICU-1' })];
      input.claim.accommodationType = 'GENERAL';
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-018',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Implant prosthesis', shaServiceCode: 'IMP-1' })];
      setField(input, 'implant_documentation_present', true);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Implant prosthesis', shaServiceCode: 'IMP-1' })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-019',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 500 })];
      setField(input, 'annual_benefit_used', 1000);
      setField(input, 'annual_benefit_limit', 2000);
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 1500 })];
      setField(input, 'annual_benefit_used', 1000);
      setField(input, 'annual_benefit_limit', 2000);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'FIN-020',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 500 })];
      setField(input, 'claim_total_amount', 500);
      setField(input, 'annual_benefit_limit', 10000);
      setField(input, 'formulary_approved', true);
      setField(input, 'duplicate_claim_detected', false);
    },
    failSetup: (input) => {
      setField(input, 'duplicate_claim_detected', true);
      setField(input, 'formulary_approved', false);
    },
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'FIN-021',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 1000 })];
      input.claim.hospitalApprovedTotal = 1020;
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 1000 })];
      input.claim.hospitalApprovedTotal = 1300;
    },
    expectedFail: RuleResultStatus.WARNING,
  },
];

describe('Financial rules FIN-001 to FIN-021', () => {
  for (const scenario of scenarios) {
    it(`${scenario.ruleId} returns PASS in valid scenario`, () => {
      const input = createRuleInput();
      scenario.passSetup(input);

      const result = evaluateRule(scenario.ruleId, input);
      expect(result.result).toBe(RuleResultStatus.PASS);
    });

    it(`${scenario.ruleId} returns ${scenario.expectedFail} in invalid scenario`, () => {
      const input = createRuleInput();
      scenario.failSetup(input);

      const result = evaluateRule(scenario.ruleId, input);
      expect(result.result).toBe(scenario.expectedFail);
    });
  }
});
