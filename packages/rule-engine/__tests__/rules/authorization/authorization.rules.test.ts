import { ClaimType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import {
  createRuleInput,
  evaluateRule,
  makeLine,
  setClaimType,
  setField,
} from '../helpers/rule-test-helpers.js';

type AuthorizationRuleId =
  | 'AUT-001'
  | 'AUT-002'
  | 'AUT-003'
  | 'AUT-004'
  | 'AUT-005'
  | 'AUT-006'
  | 'AUT-007'
  | 'AUT-008'
  | 'AUT-009'
  | 'AUT-010'
  | 'AUT-011'
  | 'AUT-012'
  | 'AUT-013'
  | 'AUT-014'
  | 'AUT-015';

interface Scenario {
  ruleId: AuthorizationRuleId;
  passSetup: (input: ReturnType<typeof createRuleInput>) => void;
  failSetup: (input: ReturnType<typeof createRuleInput>) => void;
  expectedFail: RuleResultStatus;
}

const scenarios: Scenario[] = [
  {
    ruleId: 'AUT-001',
    passSetup: (_input) => {
      // Default no preauth required.
    },
    failSetup: (input) => setField(input, 'preauth_required', true),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-002',
    passSetup: (input) => {
      setField(input, 'preauth_required', true);
      input.claim.preauthNumber = 'PA-ABCD1234';
    },
    failSetup: (input) => {
      setField(input, 'preauth_required', true);
      input.claim.preauthNumber = '123';
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-003',
    passSetup: (input) => {
      setField(input, 'preauth_required', true);
      setField(input, 'preauth_expiry_date', '2026-04-01');
      input.claim.admissionDate = '2026-03-10';
    },
    failSetup: (input) => {
      setField(input, 'preauth_required', true);
      setField(input, 'preauth_expiry_date', '2026-03-01');
      input.claim.admissionDate = '2026-03-10';
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-004',
    passSetup: (input) => {
      setField(input, 'preauth_required', true);
      setField(input, 'preauth_service_codes', 'SVC-100,SVC-200');
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-100' }), makeLine({ lineNumber: 2, shaServiceCode: 'SVC-200' })];
    },
    failSetup: (input) => {
      setField(input, 'preauth_required', true);
      setField(input, 'preauth_service_codes', 'SVC-100');
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-200' })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-005',
    passSetup: (input) => setField(input, 'preauth_facility_code', input.facilityContext.facilityCode ?? 'FID-22-106718-4'),
    failSetup: (input) => setField(input, 'preauth_facility_code', 'FID-00-000000-0'),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-006',
    passSetup: (input) => setField(input, 'preauth_patient_sha_id', input.claim.patientShaId ?? 'CR123456789-1'),
    failSetup: (input) => setField(input, 'preauth_patient_sha_id', 'CR000000000-0'),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-007',
    passSetup: (input) => {
      input.claim.shaBenefitPackage = 'SHA-BASE';
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-1' })];
      input.tariffs.byServiceCode = {
        'SVC-1': [{ serviceCode: 'SVC-1', facilityTier: 'LEVEL_4', maxAmount: 1000, benefitPackage: 'SHA-BASE' }],
      };
    },
    failSetup: (input) => {
      input.claim.shaBenefitPackage = 'SHA-BASE';
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-1' })];
      input.tariffs.byServiceCode = {
        'SVC-1': [{ serviceCode: 'SVC-1', facilityTier: 'LEVEL_4', maxAmount: 1000, benefitPackage: 'SHA-PREMIUM' }],
      };
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-008',
    passSetup: (input) => {
      setField(input, 'referred', true);
      setField(input, 'referral_authorized', true);
    },
    failSetup: (input) => setField(input, 'referred', true),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-009',
    passSetup: (input) => {
      input.claim.admissionDate = '2026-03-01';
      setField(input, 'submission_date', '2026-03-05');
    },
    failSetup: (input) => {
      input.claim.admissionDate = '2026-03-01';
      setField(input, 'submission_date', '2026-03-20');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-010',
    passSetup: (_input) => setField(_input, 'duplicate_claim_detected', false),
    failSetup: (_input) => setField(_input, 'duplicate_claim_detected', true),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-011',
    passSetup: (input) => {
      setField(input, 'copay_required', true);
      setField(input, 'copay_amount', 200);
    },
    failSetup: (input) => setField(input, 'copay_required', true),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-012',
    passSetup: (input) => {
      setClaimType(input, ClaimType.EMERGENCY);
      setField(input, 'retroauth_documented', true);
    },
    failSetup: (input) => setClaimType(input, ClaimType.EMERGENCY),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-013',
    passSetup: (input) => {
      input.registryResults.patient = { eligible: true };
      setField(input, 'coverage_end_date', '2026-12-31');
      input.claim.admissionDate = '2026-03-01';
    },
    failSetup: (input) => {
      input.registryResults.patient = { eligible: false };
      input.claim.admissionDate = '2026-03-01';
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-014',
    passSetup: (input) => {
      setField(input, 'tertiary_referral', true);
      setField(input, 'referral_chain_complete', true);
    },
    failSetup: (input) => {
      setField(input, 'tertiary_referral', true);
      setField(input, 'referral_chain_complete', false);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'AUT-015',
    passSetup: (input) => {
      input.claim.shaBenefitPackage = 'SHA-BASE';
      input.registryResults.patient = { eligible: true };
      setField(input, 'duplicate_claim_detected', false);
    },
    failSetup: (input) => {
      setField(input, 'duplicate_claim_detected', true);
      input.registryResults.patient = { eligible: false };
    },
    expectedFail: RuleResultStatus.WARNING,
  },
];

describe('Authorization rules AUT-001 to AUT-015', () => {
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
