import {
  ClaimType,
  DocumentType,
  type ClaimLine,
  type RuleResultStatus,
  type DocProcessingRoute,
  type DocProcessingStatus,
} from '@claimflow/shared';
import { RULE_ID_TO_LOGIC_KEY, type SupportedRuleId } from '../../../src/rules/catalog.js';
import { ruleLogicRegistry } from '../../../src/registry.js';
import type { DocumentSummary, RuleEngineInput } from '../../../src/types.js';
import { createRuleInput as createBaseInput } from '../../helpers/test-data.js';

export function createRuleInput(overrides?: Partial<RuleEngineInput>): RuleEngineInput {
  const input = createBaseInput(overrides);

  if (!input.claim.lines) {
    input.claim.lines = [];
  }

  return input;
}

export function evaluateRule(ruleId: SupportedRuleId, input: RuleEngineInput): {
  result: RuleResultStatus;
  evidence?: { field?: string; expected?: string; actual?: string; documentId?: string; page?: number; reason?: string };
} {
  const logicKey = RULE_ID_TO_LOGIC_KEY[ruleId];
  const ruleFn = ruleLogicRegistry[logicKey];

  if (!ruleFn) {
    throw new Error(`No logic registered for rule ${ruleId} (${logicKey})`);
  }

  return ruleFn(input, {});
}

export function setField(input: RuleEngineInput, key: string, value: string | number | boolean | null): void {
  input.extractedFields.set(key, {
    key,
    value,
    confidence: 0.95,
  });
}

export function makeDocument(params: {
  id?: string;
  docType: DocumentType;
  textContent?: string;
  metadata?: Record<string, unknown>;
}): DocumentSummary {
  return {
    id: params.id ?? `${params.docType}-doc`,
    docType: params.docType,
    processingRoute: 'FULL_OCR_EXTRACT' as DocProcessingRoute,
    processingStatus: 'COMPLETED' as DocProcessingStatus,
    textContent: params.textContent,
    metadata: params.metadata,
  };
}

export function makeLine(params: Partial<ClaimLine> = {}): ClaimLine {
  return {
    id: params.id ?? 'line-1',
    claimId: params.claimId ?? 'claim-1',
    lineNumber: params.lineNumber ?? 1,
    shaServiceCode: params.shaServiceCode ?? 'GEN-001',
    description: params.description ?? 'General service',
    icdCode: params.icdCode ?? null,
    procedureCode: params.procedureCode ?? null,
    caseCode: params.caseCode ?? null,
    quantity: params.quantity ?? 1,
    unitPrice: params.unitPrice ?? 100,
    totalAmount: params.totalAmount ?? 100,
    billAmount: params.billAmount ?? null,
    preauthNumber: params.preauthNumber ?? null,
    status: params.status ?? 'ACTIVE',
    validationNotes: params.validationNotes ?? null,
    createdAt: params.createdAt ?? '2026-03-05T00:00:00.000Z',
  };
}

export function setClaimType(input: RuleEngineInput, claimType: ClaimType): void {
  input.claim.claimType = claimType;
}

