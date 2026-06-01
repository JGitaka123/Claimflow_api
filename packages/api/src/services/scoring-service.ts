import {
  AuditDecision,
  ClaimType,
  DomainError,
  ErrorCode,
  RecommendedAction,
  RiskLevel,
  RuleResultStatus,
  RuleSeverity,
  VisitType,
  type ClaimScoreResult,
  type CreateClaimInput,
  type FhirClaimResource,
  type ScoreFlag,
  type ScoreClaimInput,
} from '@claimflow/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { TenantDb } from '../db/client.js';
import type { Config } from '../config.js';
import { createClaimService, type ClaimService } from './claim-service.js';
import {
  createAuditPipelineService,
  type AuditPipelineService,
  type AuditSessionResult,
} from '../workflows/audit-pipeline.js';

interface ScoreClaimParams {
  tenantId: string;
  userId: string;
  requestId: string;
  input: ScoreClaimInput;
  idempotencyKey?: string;
}

interface ScoreClaimOutcome {
  statusCode: number;
  result: ClaimScoreResult;
  idempotentReplay: boolean;
}

const CLAIM_TYPES = new Set<string>(Object.values(ClaimType));

function firstCodingCode(concept: FhirClaimResource['type']): string | undefined {
  return concept?.coding?.find((coding) => typeof coding.code === 'string' && coding.code.length > 0)?.code;
}

function mapClaimType(claim: FhirClaimResource): ClaimType {
  const raw = firstCodingCode(claim.type);
  const normalized = raw?.toUpperCase();

  if (normalized && CLAIM_TYPES.has(normalized)) {
    return normalized as ClaimType;
  }

  return ClaimType.OUTPATIENT;
}

function dateOnly(value: string | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

/** Map the FHIR R4 Claim subset to the internal CreateClaimInput. */
export function mapFhirClaimToCreateInput(input: ScoreClaimInput): CreateClaimInput {
  const { claim } = input;

  const admissionDate = dateOnly(claim.billablePeriod?.start);
  if (!admissionDate) {
    throw new DomainError(ErrorCode.VALIDATION_ERROR, 'claim.billablePeriod.start is required', {
      field: 'claim.billablePeriod.start',
    });
  }

  const primaryDiagnosis =
    (claim.diagnosis ?? []).find((entry) => entry.sequence === 1) ?? claim.diagnosis?.[0];
  const primaryDiagnosisCode = primaryDiagnosis?.diagnosisCodeableConcept?.coding?.find(
    (coding) => typeof coding.code === 'string',
  )?.code;

  const lines = (claim.item ?? []).map((item) => {
    const code = item.productOrService.coding?.find((coding) => typeof coding.code === 'string')?.code;
    const description = item.productOrService.text ?? code ?? 'Item';
    const quantity = item.quantity?.value && item.quantity.value > 0 ? Math.trunc(item.quantity.value) : 1;
    const unitPrice =
      item.unitPrice?.value ??
      (item.net?.value !== undefined ? item.net.value / quantity : 0);

    return {
      shaServiceCode: code ?? 'UNKNOWN',
      description: description.slice(0, 500),
      quantity,
      unitPrice: Math.max(0, unitPrice),
    };
  });

  const base: CreateClaimInput = {
    facilityId: input.facilityId,
    claimType: mapClaimType(claim),
    visitType: VisitType.OP,
    admissionDate,
    lines,
  };

  if (input.payerId) {
    base.payerId = input.payerId;
  }

  const patientShaId = claim.patient?.identifier?.value;
  if (patientShaId) {
    base.patientShaId = patientShaId;
  }

  const patientName = claim.patient?.display;
  if (patientName) {
    base.patientName = patientName;
  }

  const dischargeDate = dateOnly(claim.billablePeriod?.end);
  if (dischargeDate) {
    base.dischargeDate = dischargeDate;
  }

  if (primaryDiagnosisCode) {
    base.primaryDiagnosisCode = primaryDiagnosisCode;
  }

  return base;
}

function deriveRiskLevel(decision: AuditDecision | null): RiskLevel {
  if (decision === AuditDecision.FAILED) {
    return RiskLevel.HIGH;
  }

  if (decision === AuditDecision.WARNING) {
    return RiskLevel.MEDIUM;
  }

  return RiskLevel.LOW;
}

function deriveRecommendedAction(
  decision: AuditDecision | null,
  flags: ScoreFlag[],
): RecommendedAction {
  if (decision === AuditDecision.FAILED) {
    const hardStop = flags.some((flag) => flag.severity === RuleSeverity.HARD_STOP);
    return hardStop ? RecommendedAction.DO_NOT_SUBMIT : RecommendedAction.FIX_REQUIRED;
  }

  if (decision === AuditDecision.WARNING) {
    return RecommendedAction.REVIEW_RECOMMENDED;
  }

  return RecommendedAction.READY_FOR_SUBMISSION;
}

/**
 * Map an internal audit result to the public, integrity-safe score result. Only
 * scores, flags, reason codes, category, severity, and a short message are exposed;
 * thresholds, logic keys, params, and evidence are deliberately omitted.
 */
export function mapAuditToScoreResult(
  claim: { id: string; payerSlug?: string | null; payerName?: string | null },
  audit: AuditSessionResult,
): ClaimScoreResult {
  const session = audit.auditSession;

  const flags: ScoreFlag[] = audit.ruleResults
    .filter(
      (result) =>
        result.result === RuleResultStatus.FAIL ||
        result.result === RuleResultStatus.WARNING ||
        result.result === RuleResultStatus.INCOMPLETE,
    )
    .map((result) => ({
      reasonCode: `CF-${result.ruleId}`,
      category: result.category,
      severity: result.severity,
      message: result.message,
      auditorGeneralTypology: null,
    }));

  const deterministicScore = session.deterministicScore ?? 0;
  const riskScore = Math.max(0, Math.min(100, Math.round((1 - deterministicScore) * 100)));

  return {
    claimId: claim.id,
    auditId: session.id,
    payer: { slug: session.payerSlug ?? claim.payerSlug ?? null, name: claim.payerName ?? null },
    decision: session.decision,
    riskScore,
    riskLevel: deriveRiskLevel(session.decision),
    recommendedAction: deriveRecommendedAction(session.decision, flags),
    flags,
    counts: {
      failed: session.failedCount,
      warning: session.warningCount,
      incomplete: session.incompleteCount,
      passed: session.passedCount,
    },
  };
}

export class ScoringService {
  private readonly claimService: ClaimService;
  private readonly auditPipeline: AuditPipelineService;

  constructor(pool: TenantDb, logger: FastifyBaseLogger, config: Config) {
    this.claimService = createClaimService(pool, logger);
    this.auditPipeline = createAuditPipelineService(pool, logger, config);
  }

  async scoreClaim(params: ScoreClaimParams): Promise<ScoreClaimOutcome> {
    const body = mapFhirClaimToCreateInput(params.input);

    const created = await this.claimService.createClaim({
      tenantId: params.tenantId,
      userId: params.userId,
      requestId: params.requestId,
      body,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    });

    const claim = created.payload.data.claim;

    let audit: AuditSessionResult;

    if (created.idempotentReplay) {
      // The claim already exists from a prior identical request; return its score
      // without creating a new audit session. Fall back to scoring if none exists.
      try {
        audit = await this.auditPipeline.getLatestAuditForClaim({
          claimId: claim.id,
          tenantId: params.tenantId,
        });
      } catch {
        audit = await this.auditPipeline.scoreClaimStructured({
          claimId: claim.id,
          tenantId: params.tenantId,
          userId: params.userId,
        });
      }
    } else {
      audit = await this.auditPipeline.scoreClaimStructured({
        claimId: claim.id,
        tenantId: params.tenantId,
        userId: params.userId,
      });
    }

    return {
      statusCode: created.idempotentReplay ? 200 : 201,
      result: mapAuditToScoreResult(claim, audit),
      idempotentReplay: created.idempotentReplay,
    };
  }
}

export function createScoringService(pool: TenantDb, logger: FastifyBaseLogger, config: Config): ScoringService {
  return new ScoringService(pool, logger, config);
}
