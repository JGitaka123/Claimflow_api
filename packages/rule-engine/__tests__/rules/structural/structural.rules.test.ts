import { DocumentType, RuleResultStatus } from '@claimflow/shared';
import { describe, expect, it } from 'vitest';
import {
  createRuleInput,
  evaluateRule,
  makeDocument,
  makeLine,
  setField,
} from '../helpers/rule-test-helpers.js';

type StructuralRuleId =
  | 'STR-001'
  | 'STR-002'
  | 'STR-003'
  | 'STR-004'
  | 'STR-005'
  | 'STR-006'
  | 'STR-007'
  | 'STR-008'
  | 'STR-009'
  | 'STR-010';

interface Scenario {
  ruleId: StructuralRuleId;
  passSetup: (input: ReturnType<typeof createRuleInput>) => void;
  failSetup: (input: ReturnType<typeof createRuleInput>) => void;
  expectedFail: RuleResultStatus;
}

const scenarios: Scenario[] = [
  {
    ruleId: 'STR-001',
    passSetup: (input) => {
      input.claim.lines = [makeLine()];
    },
    failSetup: (input) => {
      input.claim.lines = [];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-002',
    passSetup: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES }));
    },
    failSetup: (_input) => {
      // no docs
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-003',
    passSetup: (_input) => {
      // Default required fields present.
    },
    failSetup: (input) => {
      input.claim.patientShaId = null;
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-004',
    passSetup: (input) => {
      input.claim.admissionDate = '2026-03-01';
      input.claim.dischargeDate = '2026-03-05';
    },
    failSetup: (input) => {
      input.claim.admissionDate = '2026-03-05';
      input.claim.dischargeDate = '2026-03-01';
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-005',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ lineNumber: 1 }), makeLine({ lineNumber: 2, id: 'line-2' })];
    },
    failSetup: (input) => {
      input.claim.lines = [makeLine({ lineNumber: 2 })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-006',
    passSetup: (input) => {
      input.claim.dedupHash = 'abc123';
      setField(input, 'duplicate_claim_detected', false);
    },
    failSetup: (input) => {
      input.claim.dedupHash = 'abc123';
      setField(input, 'duplicate_claim_detected', true);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-007',
    passSetup: (input) => {
      input.extractedFields.set('field_1', { key: 'field_1', value: 'value', confidence: 0.95 });
      input.extractedFields.set('field_2', { key: 'field_2', value: 'value', confidence: 0.9 });
    },
    failSetup: (input) => {
      input.extractedFields.set('field_1', { key: 'field_1', value: 'value', confidence: 0.4 });
      input.extractedFields.set('field_2', { key: 'field_2', value: 'value', confidence: 0.5 });
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-008',
    passSetup: (input) => {
      const document = makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, id: 'doc-1' });
      document.pageCount = 10;
      input.documents.push(document);
    },
    failSetup: (input) => {
      const document = makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, id: 'doc-1' });
      document.pageCount = 60;
      input.documents.push(document);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-009',
    passSetup: (input) => setField(input, 'rulepack_integrity_ok', true),
    failSetup: (input) => setField(input, 'rulepack_integrity_ok', false),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'STR-010',
    passSetup: (input) => {
      input.claim.lines = [makeLine({ totalAmount: 500 })];
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES }));
      input.claim.patientName = 'Jane Doe';
      setField(input, 'physician_signature_present', true);
    },
    failSetup: (input) => {
      input.claim.lines = [];
      input.documents = [];
      input.claim.patientName = null;
      setField(input, 'physician_signature_present', false);
    },
    expectedFail: RuleResultStatus.WARNING,
  },
];

describe('Structural rules STR-001 to STR-010', () => {
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
