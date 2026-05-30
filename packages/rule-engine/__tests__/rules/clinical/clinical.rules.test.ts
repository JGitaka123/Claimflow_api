import { ClaimType, DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import {
  createRuleInput,
  evaluateRule,
  makeDocument,
  makeLine,
  setClaimType,
  setField,
} from '../helpers/rule-test-helpers.js';

type ClinicalRuleId =
  | 'CLN-001'
  | 'CLN-002'
  | 'CLN-003'
  | 'CLN-004'
  | 'CLN-005'
  | 'CLN-006'
  | 'CLN-007'
  | 'CLN-008'
  | 'CLN-009'
  | 'CLN-010'
  | 'CLN-011'
  | 'CLN-012'
  | 'CLN-013'
  | 'CLN-014'
  | 'CLN-015'
  | 'CLN-016'
  | 'CLN-017'
  | 'CLN-018'
  | 'CLN-019'
  | 'CLN-020'
  | 'CLN-021'
  | 'CLN-022'
  | 'CLN-023'
  | 'CLN-024'
  | 'CLN-025';

interface Scenario {
  ruleId: ClinicalRuleId;
  passSetup: (input: ReturnType<typeof createRuleInput>) => void;
  failSetup: (input: ReturnType<typeof createRuleInput>) => void;
  expectedFail: RuleResultStatus;
}

const scenarios: Scenario[] = [
  {
    ruleId: 'CLN-001',
    passSetup: (input) => {
      input.claim.primaryDiagnosisCode = 'GB61';
      input.icdLookup = { isValidCode: (code) => code === 'GB61', isLeafCode: () => true };
    },
    failSetup: (input) => {
      input.claim.primaryDiagnosisCode = 'ZZ99';
      input.icdLookup = { isValidCode: () => false, isLeafCode: () => false };
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-002',
    passSetup: (input) => {
      input.claim.primaryDiagnosisCode = 'GB61';
      input.icdLookup = { isValidCode: () => true, isLeafCode: () => true };
    },
    failSetup: (input) => {
      input.claim.primaryDiagnosisCode = 'GB61';
      input.icdLookup = { isValidCode: () => true, isLeafCode: () => false };
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-003',
    passSetup: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'diagnosis', 'pregnancy with normal delivery');
    },
    failSetup: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'diagnosis', 'ankle fracture');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-004',
    passSetup: (input) => {
      setField(input, 'diagnosis', 'end stage renal disease');
      input.claim.lines = [makeLine({ description: 'Dialysis session', shaServiceCode: 'DIAL-001' })];
    },
    failSetup: (input) => {
      setField(input, 'diagnosis', 'ankle fracture');
      input.claim.lines = [makeLine({ description: 'Dialysis session', shaServiceCode: 'DIAL-001' })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-005',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-OK' })];
      input.tariffs.byServiceCode = { 'SVC-OK': [{ serviceCode: 'SVC-OK', facilityTier: 'LEVEL_4', maxAmount: 1000 }] };
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-BAD' })];
      input.tariffs.byServiceCode = {};
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-006',
    passSetup: (input) => {
      setClaimType(input, ClaimType.INPATIENT);
      input.claim.admissionDate = '2026-03-01';
      input.claim.dischargeDate = '2026-03-05';
    },
    failSetup: (input) => {
      setClaimType(input, ClaimType.INPATIENT);
      input.claim.admissionDate = '2026-01-01';
      input.claim.dischargeDate = '2026-04-10';
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-007',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Pharmacy medication', shaServiceCode: 'RX-001' })];
      setField(input, 'diagnosis', 'bacterial infection');
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Pharmacy medication', shaServiceCode: 'RX-001' })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-008',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Laboratory CBC', shaServiceCode: 'LAB-001' })];
      setField(input, 'diagnosis', 'fever and infection');
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ description: 'Laboratory CBC', shaServiceCode: 'LAB-001' })];
      setField(input, 'diagnosis', 'ankle fracture');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-009',
    passSetup: (_input) => {
      // Default outpatient case has no contradiction.
    },
    failSetup: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'gender', 'M');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-010',
    passSetup: (input) => {
      setField(input, 'patient_age', 30);
      setField(input, 'diagnosis', 'hypertension');
    },
    failSetup: (input) => {
      setField(input, 'patient_age', 10);
      setField(input, 'diagnosis', 'prostate enlargement');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-011',
    passSetup: (input) => {
      setField(input, 'gender', 'F');
      setField(input, 'diagnosis', 'pregnancy');
    },
    failSetup: (input) => {
      setField(input, 'gender', 'M');
      setField(input, 'diagnosis', 'pregnancy');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-012',
    passSetup: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'gestational_age_weeks', 30);
    },
    failSetup: (input) => setClaimType(input, ClaimType.MATERNITY),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-013',
    passSetup: (input) => setField(input, 'blood_pressure', '120/80'),
    failSetup: (_input) => {
      // No vitals
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-014',
    passSetup: (input) => {
      setClaimType(input, ClaimType.INPATIENT);
      setField(input, 'admission_criteria_met', true);
    },
    failSetup: (input) => {
      setClaimType(input, ClaimType.INPATIENT);
      setField(input, 'admission_criteria_met', false);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-015',
    passSetup: (input) => {
      setField(input, 'diagnosis', 'diabetes mellitus');
      setField(input, 'follow_up_plan_present', true);
    },
    failSetup: (input) => {
      setField(input, 'diagnosis', 'diabetes mellitus');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-016',
    passSetup: (input) => {
      setClaimType(input, ClaimType.EMERGENCY);
      setField(input, 'triage_documented', true);
    },
    failSetup: (input) => setClaimType(input, ClaimType.EMERGENCY),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-017',
    passSetup: (input) => setField(input, 'allergy_status', 'none known'),
    failSetup: (_input) => {
      // Missing allergy documentation.
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-018',
    passSetup: (input) => {
      setClaimType(input, ClaimType.DENTAL);
      setField(input, 'dental_chart_present', true);
    },
    failSetup: (input) => setClaimType(input, ClaimType.DENTAL),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-019',
    passSetup: (input) => {
      setClaimType(input, ClaimType.OPTICAL);
      input.documents.push(makeDocument({ docType: DocumentType.PRESCRIPTION }));
    },
    failSetup: (input) => setClaimType(input, ClaimType.OPTICAL),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-020',
    passSetup: (input) => {
      setClaimType(input, ClaimType.MENTAL_HEALTH);
      setField(input, 'mental_health_assessment_present', true);
    },
    failSetup: (input) => setClaimType(input, ClaimType.MENTAL_HEALTH),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-021',
    passSetup: (input) => {
      setClaimType(input, ClaimType.RENAL);
      setField(input, 'dialysis_record_present', true);
    },
    failSetup: (input) => setClaimType(input, ClaimType.RENAL),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-022',
    passSetup: (input) => {
      setField(input, 'diagnosis', 'obesity');
      setField(input, 'bmi', 31.2);
    },
    failSetup: (input) => {
      setField(input, 'diagnosis', 'obesity');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-023',
    passSetup: (input) => {
      input.claim.admissionDate = '2026-03-01';
      input.claim.dischargeDate = '2026-03-03';
      setField(input, 'procedure_dates', '2026-03-01,2026-03-02');
    },
    failSetup: (input) => {
      input.claim.admissionDate = '2026-03-05';
      input.claim.dischargeDate = '2026-03-01';
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-024',
    passSetup: (input) => {
      setField(input, 'secondary_diagnosis_codes', 'AB01,CD02');
      setField(input, 'secondary_diagnosis_text', 'anemia and dehydration');
    },
    failSetup: (input) => {
      setField(input, 'secondary_diagnosis_codes', 'AB01,CD02');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'CLN-025',
    passSetup: (input) => {
      input.claim.primaryDiagnosisCode = 'GB61';
      input.claim.lines = [makeLine({ shaServiceCode: 'SVC-1' })];
      setField(input, 'physician_signature_present', true);
      setField(input, 'follow_up_plan_present', true);
      setField(input, 'allergy_status', 'none');
    },
    failSetup: (_input) => {
      // Empty input produces low completeness score.
    },
    expectedFail: RuleResultStatus.WARNING,
  },
];

describe('Clinical rules CLN-001 to CLN-025', () => {
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
