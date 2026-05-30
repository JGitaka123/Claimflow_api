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

type RemainingDocumentationRuleId =
  | 'DOC-016'
  | 'DOC-017'
  | 'DOC-018'
  | 'DOC-019'
  | 'DOC-020'
  | 'DOC-021'
  | 'DOC-022'
  | 'DOC-023'
  | 'DOC-024'
  | 'DOC-025'
  | 'DOC-026'
  | 'DOC-027'
  | 'DOC-028'
  | 'DOC-029'
  | 'DOC-030'
  | 'DOC-031'
  | 'DOC-032'
  | 'DOC-033'
  | 'DOC-034'
  | 'DOC-035';

interface RuleScenario {
  ruleId: RemainingDocumentationRuleId;
  setupPass: ReturnType<typeof createRuleInput> extends infer T ? (input: T) => void : never;
  setupFail: ReturnType<typeof createRuleInput> extends infer T ? (input: T) => void : never;
  expectedFail: RuleResultStatus;
}

const scenarios: RuleScenario[] = [
  {
    ruleId: 'DOC-016',
    setupPass: (input) => setField(input, 'referred', false),
    setupFail: (input) => setField(input, 'referred', true),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-017',
    setupPass: (input) => {
      setField(input, 'referred', true);
      input.documents.push(makeDocument({ docType: DocumentType.REFERRAL_LETTER, metadata: { referring_facility_recognized: true } }));
    },
    setupFail: (input) => {
      setField(input, 'referred', true);
      input.documents.push(makeDocument({ docType: DocumentType.REFERRAL_LETTER, metadata: { referring_facility_recognized: false } }));
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-018',
    setupPass: (input) => {
      setClaimType(input, ClaimType.SURGICAL);
      input.documents.push(makeDocument({ docType: DocumentType.CONSENT_FORM }));
    },
    setupFail: (input) => setClaimType(input, ClaimType.SURGICAL),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-019',
    setupPass: (input) => {
      setClaimType(input, ClaimType.SURGICAL);
      input.documents.push(makeDocument({ docType: DocumentType.CONSENT_FORM, metadata: { patient_signature_present: true } }));
    },
    setupFail: (input) => {
      setClaimType(input, ClaimType.SURGICAL);
      input.documents.push(makeDocument({ docType: DocumentType.CONSENT_FORM, metadata: { patient_signature_present: false } }));
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-020',
    setupPass: (input) => {
      setField(input, 'preauth_required', true);
      input.documents.push(makeDocument({ docType: DocumentType.PREAUTH_FORM }));
    },
    setupFail: (input) => setField(input, 'preauth_required', true),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-021',
    setupPass: (input) => {
      setClaimType(input, ClaimType.SURGICAL);
      input.documents.push(makeDocument({ docType: DocumentType.OPERATIVE_NOTE }));
    },
    setupFail: (input) => setClaimType(input, ClaimType.SURGICAL),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-022',
    setupPass: (input) => {
      setField(input, 'anesthesia_required', true);
      input.documents.push(makeDocument({ docType: DocumentType.OTHER_SUPPORTING, textContent: 'Anesthesia record available' }));
    },
    setupFail: (input) => setField(input, 'anesthesia_required', true),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-023',
    setupPass: (input) => {
      setClaimType(input, ClaimType.INPATIENT);
      setField(input, 'nursing_notes_present', true);
    },
    setupFail: (input) => setClaimType(input, ClaimType.INPATIENT),
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'DOC-024',
    setupPass: (input) => {
      input.claim.lines = [makeLine({ description: 'Radiology MRI', shaServiceCode: 'RAD-101' })];
      input.documents.push(makeDocument({ docType: DocumentType.RADIOLOGY_REPORT }));
    },
    setupFail: (input) => {
      input.claim.lines = [makeLine({ description: 'Radiology MRI', shaServiceCode: 'RAD-101' })];
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-025',
    setupPass: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, metadata: { imageQualityScore: 0.9 } }));
    },
    setupFail: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, metadata: { imageQualityScore: 0.3 } }));
    },
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'DOC-026',
    setupPass: (input) => {
      input.claim.patientName = 'Jane Doe';
      setField(input, 'claim_form_date', '2026-03-05');
      setField(input, 'physician_signature_present', true);
    },
    setupFail: (input) => {
      input.claim.patientName = null;
      setField(input, 'claim_form_date', '2026-03-05');
      setField(input, 'physician_signature_present', false);
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-027',
    setupPass: (input) => {
      setField(input, 'claim_form_date', '2026-03-05');
      setField(input, 'discharge_date', '2026-03-10');
    },
    setupFail: (input) => {
      setField(input, 'claim_form_date', '2020-01-01');
      setField(input, 'discharge_date', '2026-03-10');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-028',
    setupPass: (input) => {
      input.claim.patientName = 'Jane Doe';
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, textContent: 'Patient Jane Doe reviewed.' }));
    },
    setupFail: (input) => {
      input.claim.patientName = 'Jane Doe';
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, textContent: 'Patient not named here.' }));
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-029',
    setupPass: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, metadata: { facility_header_present: true } }));
    },
    setupFail: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES }));
    },
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'DOC-030',
    setupPass: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      input.documents.push(makeDocument({ docType: DocumentType.OTHER_SUPPORTING, textContent: 'Delivery record and partograph attached.' }));
    },
    setupFail: (input) => setClaimType(input, ClaimType.MATERNITY),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-031',
    setupPass: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'birth_notification_present', true);
    },
    setupFail: (input) => setClaimType(input, ClaimType.MATERNITY),
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-032',
    setupPass: (input) => {
      setClaimType(input, ClaimType.MATERNITY);
      setField(input, 'anc_card_present', true);
    },
    setupFail: (input) => setClaimType(input, ClaimType.MATERNITY),
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'DOC-033',
    setupPass: (input) => {
      input.claim.admissionDate = '2026-03-05';
      setField(input, 'claim_form_date', '2026-03-01');
    },
    setupFail: (input) => {
      input.claim.admissionDate = '2026-03-05';
      setField(input, 'claim_form_date', '2020-03-01');
    },
    expectedFail: RuleResultStatus.FAIL,
  },
  {
    ruleId: 'DOC-034',
    setupPass: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, textContent: 'Doc 1 unique' }));
      input.documents.push(makeDocument({ docType: DocumentType.LAB_RESULTS, textContent: 'Doc 2 unique' }));
    },
    setupFail: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, textContent: 'Duplicate body' }));
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES, textContent: 'Duplicate body' }));
    },
    expectedFail: RuleResultStatus.WARNING,
  },
  {
    ruleId: 'DOC-035',
    setupPass: (input) => {
      input.documents.push(makeDocument({ docType: DocumentType.SHA_CLAIM_FORM_OP }));
      input.documents.push(makeDocument({ docType: DocumentType.PHYSICIAN_NOTES }));
      setField(input, 'physician_signature_present', true);
      setField(input, 'claim_form_date', '2026-03-05');
    },
    setupFail: (_input) => {
      // Intentionally empty: produces low completeness score.
    },
    expectedFail: RuleResultStatus.WARNING,
  },
];

describe('Documentation rules DOC-016 to DOC-035', () => {
  for (const scenario of scenarios) {
    it(`${scenario.ruleId} returns PASS in valid scenario`, () => {
      const input = createRuleInput();
      scenario.setupPass(input);

      const result = evaluateRule(scenario.ruleId, input);
      expect(result.result).toBe(RuleResultStatus.PASS);
    });

    it(`${scenario.ruleId} returns ${scenario.expectedFail} in invalid scenario`, () => {
      const input = createRuleInput();
      scenario.setupFail(input);

      const result = evaluateRule(scenario.ruleId, input);
      expect(result.result).toBe(scenario.expectedFail);
    });
  }
});
