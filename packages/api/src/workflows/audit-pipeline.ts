
import {
  AuditDecision,
  ClaimStatus,
  ErrorCode,
  FieldConfidenceTier,
  RuleResultStatus,
  DomainError,
  WebhookEventType,
  type ClaimType,
  type RuleCategory,
  type RuleSeverity,
  type AuditSummary,
} from '@claimflow/shared';
import {
  loadRulepack,
  type DocumentSummary,
  type ExtractedFieldValue,
  type RegistryLookupResults,
  type RuleEngine,
  type RuleEngineInput,
  type TariffLookup,
  type TariffRecord,
} from '@claimflow/rule-engine';
import type { FastifyBaseLogger } from 'fastify';
import type { QueryResultRow } from 'pg';
import type { TenantDb } from '../db/client.js';
import type { Config } from '../config.js';
import { CircuitBreaker } from '../integrations/circuit-breaker.js';
import { MlClient, type MlPageResult, type MlProcessDocumentResponse } from '../integrations/ml-client.js';
import { createStateMachineWorkflow } from './state-machine.js';
import {
  createRuleEngineRegistry,
  DEFAULT_PAYER_SLUG,
  type RuleEngineRegistry,
} from './rule-engine-registry.js';
import { createWebhookService, type WebhookService } from '../services/webhook-service.js';

interface ClaimContextRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  facility_id: string;
  status: ClaimStatus;
  claim_type: ClaimType;
  admission_date: string | Date;
  discharge_date: string | Date | null;
  patient_sha_id: string | null;
  patient_name_enc: string | null;
  patient_national_id_enc: string | null;
  primary_diagnosis_code: string | null;
  visit_type: string;
  hmis_ref: string | null;
  facility_sha_code: string | null;
  facility_tier: string | null;
  payer_id: string | null;
  payer_slug: string | null;
  payer_status: string | null;
  payer_rulepack_version: string | null;
}

interface ClaimLineRow extends QueryResultRow {
  id: string;
  claim_id: string;
  line_number: number;
  sha_service_code: string;
  description: string;
  icd_code: string | null;
  procedure_code: string | null;
  case_code: string | null;
  quantity: number;
  unit_price: string | number;
  total_amount: string | number;
  bill_amount: string | number | null;
  preauth_number: string | null;
  status: string;
  validation_notes: string | null;
  created_at: string | Date;
}

interface DocumentRow extends QueryResultRow {
  id: string;
  claim_id: string;
  doc_type: string;
  processing_route: string;
  mime_type: string;
  original_filename: string;
  page_count: number;
  storage_path: string;
  processing_status: string;
}

interface TariffRow extends QueryResultRow {
  sha_service_code: string;
  facility_tier: string | null;
  max_amount_kes: string | number;
  benefit_package: string;
}

interface AuditSessionRow extends QueryResultRow {
  id: string;
  claim_id: string;
  user_id: string;
  rulepack_version: string;
  rulepack_checksum: string;
  payer_id: string | null;
  payer_slug: string | null;
  decision: AuditDecision | null;
  total_rules: number;
  passed_count: number;
  failed_count: number;
  warning_count: number;
  incomplete_count: number;
  skipped_count: number;
  deterministic_score: number | null;
  ml_quality_score: number | null;
  fix_report_md: string | null;
  execution_time_ms: number | null;
  started_at: string | Date;
  completed_at: string | Date | null;
}

interface RuleResultRow extends QueryResultRow {
  id: string;
  audit_session_id: string;
  rule_id: string;
  category: RuleCategory;
  severity: RuleSeverity;
  result: RuleResultStatus;
  message: string;
  remediation: string | null;
  evidence_json: Record<string, unknown> | null;
  execution_time_ms: number | null;
  created_at: string | Date;
}

interface ProcessedDocumentOutcome {
  document: DocumentSummary;
  extractedFields: NormalizedExtractedField[];
  qualityScores: number[];
}

interface NormalizedExtractedField {
  key: string;
  value: string | number | boolean | null;
  confidence: number;
  documentId: string;
  pageNumber: number;
  bbox: { x: number; y: number; w: number; h: number } | null;
}

interface ExecuteAuditPipelineParams {
  claimId: string;
  tenantId: string;
  userId: string;
  locale?: string;
  forceReprocess?: boolean;
}

interface FindAuditByIdParams {
  auditId: string;
  tenantId: string;
}

interface FindLatestAuditParams {
  claimId: string;
  tenantId: string;
}

export interface AuditSessionResult {
  auditSession: {
    id: string;
    claimId: string;
    userId: string;
    rulepackVersion: string;
    rulepackChecksum: string;
    payerId: string | null;
    payerSlug: string | null;
    decision: AuditDecision | null;
    totalRules: number;
    passedCount: number;
    failedCount: number;
    warningCount: number;
    incompleteCount: number;
    skippedCount: number;
    deterministicScore: number | null;
    mlQualityScore: number | null;
    fixReportMd: string | null;
    executionTimeMs: number | null;
    startedAt: string;
    completedAt: string | null;
  };
  ruleResults: Array<{
    id: string;
    ruleId: string;
    category: RuleCategory;
    severity: RuleSeverity;
    result: RuleResultStatus;
    message: string;
    remediation: string | null;
    evidence: Record<string, unknown> | null;
    executionTimeMs: number | null;
    createdAt: string;
  }>;
}

interface AuditPipelineDependencies {
  mlClient?: MlClient;
  ruleEngine?: RuleEngine;
}

/**
 * Project a full AuditSessionResult down to the public-safe AuditSummary.
 * Drops the four rule internals (evidence, deterministicScore, mlQualityScore,
 * fixReportMd) and per-rule remediation — they never enter the public path.
 * Used by the customer-facing audit endpoints; the /internal endpoints return
 * the full result to platform staff only.
 */
export function toAuditSummary(
  full: AuditSessionResult,
  payerName: string | null = null,
): AuditSummary {
  const s = full.auditSession;
  return {
    auditId: s.id,
    claimId: s.claimId,
    payer: { slug: s.payerSlug, name: payerName },
    decision: s.decision,
    totalRules: s.totalRules,
    passedCount: s.passedCount,
    failedCount: s.failedCount,
    warningCount: s.warningCount,
    incompleteCount: s.incompleteCount,
    skippedCount: s.skippedCount,
    rulepackVersion: s.rulepackVersion,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    findings: full.ruleResults.map((r) => ({
      ruleId: r.ruleId,
      category: r.category,
      severity: r.severity,
      result: r.result,
      message: r.message,
      // Typology mapping not yet supplied (build-now/map-later); null for now.
      auditorGeneralTypology: null,
    })),
  };
}

function toIso(value: string | Date | null): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function toDateOnly(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value.slice(0, 10);
}

function toNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  return typeof value === 'number' ? value : Number.parseFloat(value);
}

function normalizeField(input: Record<string, unknown>, fallbackPageNumber: number): NormalizedExtractedField | null {
  const keyCandidate = input.field_key ?? input.fieldKey ?? input.key;
  const key = typeof keyCandidate === 'string' ? keyCandidate.trim() : '';

  if (key.length === 0) {
    return null;
  }

  const rawValue = input.value ?? input.field_value ?? input.fieldValue ?? null;
  const value =
    typeof rawValue === 'string' ||
    typeof rawValue === 'number' ||
    typeof rawValue === 'boolean' ||
    rawValue === null
      ? rawValue
      : JSON.stringify(rawValue);

  const confidenceRaw = input.confidence;
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.5;

  const pageRaw = input.page_number ?? input.pageNumber;
  const pageNumber =
    typeof pageRaw === 'number' && Number.isInteger(pageRaw) && pageRaw > 0
      ? pageRaw
      : fallbackPageNumber;

  const bboxRaw = input.bbox;
  let bbox: { x: number; y: number; w: number; h: number } | null = null;

  if (
    typeof bboxRaw === 'object' &&
    bboxRaw !== null &&
    typeof (bboxRaw as { x?: unknown }).x === 'number' &&
    typeof (bboxRaw as { y?: unknown }).y === 'number' &&
    typeof (bboxRaw as { w?: unknown }).w === 'number' &&
    typeof (bboxRaw as { h?: unknown }).h === 'number'
  ) {
    bbox = {
      x: (bboxRaw as { x: number }).x,
      y: (bboxRaw as { y: number }).y,
      w: (bboxRaw as { w: number }).w,
      h: (bboxRaw as { h: number }).h,
    };
  }

  return {
    key,
    value,
    confidence,
    documentId: '',
    pageNumber,
    bbox,
  };
}

function determineConfidenceTier(confidence: number, highThreshold: number, lowThreshold: number): FieldConfidenceTier {
  if (confidence >= highThreshold) {
    return FieldConfidenceTier.HIGH;
  }

  if (confidence >= lowThreshold) {
    return FieldConfidenceTier.MEDIUM;
  }

  return FieldConfidenceTier.LOW;
}

export class AuditPipelineService {
  private readonly engineRegistry: RuleEngineRegistry;
  private readonly mlClient: MlClient;
  private readonly stateMachine: ReturnType<typeof createStateMachineWorkflow>;
  private readonly registryCircuitBreaker: CircuitBreaker<[], RegistryLookupResults>;
  private readonly webhookService: WebhookService;

  constructor(
    private readonly pool: TenantDb,
    private readonly logger: FastifyBaseLogger,
    private readonly config: Config,
    dependencies: AuditPipelineDependencies = {},
  ) {
    this.engineRegistry = createRuleEngineRegistry({
      rulepackDir: config.RULEPACK_DIR,
      ...(dependencies.ruleEngine ? { defaultEngine: dependencies.ruleEngine } : {}),
    });
    this.mlClient =
      dependencies.mlClient ??
      new MlClient({
        baseUrl: config.ML_SERVICE_URL,
        timeoutMs: config.ML_TIMEOUT_MS,
        retriesOnTimeout: 1,
      });

    this.stateMachine = createStateMachineWorkflow(pool);
    this.webhookService = createWebhookService(pool, logger);

    this.registryCircuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 300_000,
      timeoutMs: 10_000,
    });
  }

  async executeAuditPipeline(params: ExecuteAuditPipelineParams): Promise<AuditSessionResult> {
    const locale = params.locale ?? 'en';
    const startedAt = new Date();

    const claim = await this.loadClaimContext(params.claimId, params.tenantId);

    if (claim.documents.length === 0) {
      throw new DomainError(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Claim must have at least one document before audit can run',
      );
    }

    if (![ClaimStatus.DOCUMENTS_UPLOADED, ClaimStatus.CORRECTIONS_IN_PROGRESS].includes(claim.row.status)) {
      throw new DomainError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Cannot audit claim in status ${claim.row.status}`,
      );
    }

    // Resolve the claim's payer and select its rule engine *before* any ML work,
    // so a payer without an authoritative rulepack fails closed early.
    const payer = this.resolveClaimPayer(claim.row);
    const engine = this.engineRegistry.getEngineForPayer({
      slug: payer.slug,
      rulepackVersion: payer.rulepackVersion,
    });

    await this.pool.query(
      `INSERT INTO audit_trail (
          tenant_id,
          claim_id,
          user_id,
          action,
          detail_json
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'AUDIT_STARTED'::audit_action,
          $4::jsonb
        )`,
      [
        params.tenantId,
        params.claimId,
        params.userId,
        JSON.stringify({
          source: 'audit_pipeline',
          forceReprocess: Boolean(params.forceReprocess),
        }),
      ],
    );

    await this.stateMachine.transitionClaim({
      claimId: params.claimId,
      tenantId: params.tenantId,
      toStatus: ClaimStatus.PROCESSING,
      userId: params.userId,
      metadata: {
        source: 'audit_pipeline',
      },
    });

    const processingOutcomes = await Promise.allSettled(
      claim.documents.map((document) => this.processDocument(document)),
    );

    const normalizedDocuments: DocumentSummary[] = [];
    const extractedFields: NormalizedExtractedField[] = [];
    const qualityScores: number[] = [];

    for (const [index, result] of processingOutcomes.entries()) {
      const sourceDocument = claim.documents[index];

      if (!sourceDocument) {
        continue;
      }

      if (result.status === 'fulfilled') {
        normalizedDocuments.push(result.value.document);
        extractedFields.push(...result.value.extractedFields);
        qualityScores.push(...result.value.qualityScores);
      } else {
        normalizedDocuments.push({
          id: sourceDocument.id,
          docType: sourceDocument.doc_type as never,
          pageCount: sourceDocument.page_count,
          processingStatus: 'FAILED' as never,
          metadata: {
            processing_error: result.reason instanceof Error ? result.reason.message : 'document_processing_failed',
          },
        });
      }
    }

    await this.persistExtractedFields(params.claimId, params.tenantId, extractedFields);

    const extractedFieldMap = this.toExtractedFieldMap(extractedFields);
    const registryResults = await this.fetchRegistryDataStub(claim.row);
    const tariffs = await this.loadActiveTariffs();

    const input: RuleEngineInput = {
      claim: {
        id: claim.row.id,
        claimType: claim.row.claim_type,
        tenantId: claim.row.tenant_id,
        facilityId: claim.row.facility_id,
        admissionDate: toDateOnly(claim.row.admission_date),
        dischargeDate: claim.row.discharge_date ? toDateOnly(claim.row.discharge_date) : null,
        patientShaId: claim.row.patient_sha_id,
        patientName: claim.row.patient_name_enc,
        patientNationalId: claim.row.patient_national_id_enc,
        primaryDiagnosisCode: claim.row.primary_diagnosis_code,
        lines: claim.lines.map((line) => ({
          id: line.id,
          claimId: line.claim_id,
          lineNumber: line.line_number,
          shaServiceCode: line.sha_service_code,
          description: line.description,
          icdCode: line.icd_code,
          procedureCode: line.procedure_code,
          caseCode: line.case_code,
          quantity: line.quantity,
          unitPrice: toNumber(line.unit_price) ?? 0,
          totalAmount: toNumber(line.total_amount) ?? 0,
          billAmount: toNumber(line.bill_amount),
          preauthNumber: line.preauth_number,
          status: line.status,
          validationNotes: line.validation_notes,
          createdAt: toIso(line.created_at) ?? new Date().toISOString(),
        })),
      },
      extractedFields: extractedFieldMap,
      documents: normalizedDocuments,
      facilityContext: {
        facilityId: claim.row.facility_id,
        facilityCode: claim.row.facility_sha_code ?? undefined,
        facilityTier: claim.row.facility_tier ?? undefined,
      },
      tariffs,
      registryResults,
    };

    const evaluation = await engine.evaluate(input, locale);

    const counts = {
      passed: evaluation.results.filter((result) => result.result === RuleResultStatus.PASS).length,
      failed: evaluation.results.filter((result) => result.result === RuleResultStatus.FAIL).length,
      warning: evaluation.results.filter((result) => result.result === RuleResultStatus.WARNING).length,
      incomplete: evaluation.results.filter((result) => result.result === RuleResultStatus.INCOMPLETE).length,
      skipped: evaluation.results.filter((result) => result.result === RuleResultStatus.SKIPPED).length,
    };

    const deterministicScore = evaluation.totalRules > 0 ? counts.passed / evaluation.totalRules : 0;
    const mlQualityScore = qualityScores.length > 0
      ? qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length
      : null;

    const rulepackVersion = evaluation.rulepackVersion ?? engine.activeVersion;
    const loaderPayerSlug = payer.slug === DEFAULT_PAYER_SLUG ? undefined : payer.slug;
    const rulepackChecksum = await this.resolveRulepackChecksum(rulepackVersion, loaderPayerSlug);

    const sessionInsert = await this.pool.query<{ id: string }>(
      `INSERT INTO audit_sessions (
          claim_id,
          tenant_id,
          user_id,
          rulepack_version,
          rulepack_checksum,
          decision,
          total_rules,
          passed_count,
          failed_count,
          warning_count,
          incomplete_count,
          skipped_count,
          deterministic_score,
          ml_quality_score,
          fix_report_md,
          execution_time_ms,
          started_at,
          completed_at,
          payer_id,
          payer_slug
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6::audit_decision,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15,
          $16,
          $17::timestamptz,
          now(),
          $18::uuid,
          $19
        )
        RETURNING id`,
      [
        params.claimId,
        params.tenantId,
        params.userId,
        rulepackVersion,
        rulepackChecksum,
        evaluation.decision,
        evaluation.totalRules,
        counts.passed,
        counts.failed,
        counts.warning,
        counts.incomplete,
        counts.skipped,
        deterministicScore,
        mlQualityScore,
        evaluation.fixReportMarkdown,
        Math.round(evaluation.executionTimeMs),
        startedAt.toISOString(),
        payer.id,
        payer.slug,
      ],
    );

    const auditSessionId = sessionInsert.rows[0]?.id;

    if (!auditSessionId) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create audit session');
    }

    for (const result of evaluation.results) {
      await this.pool.query(
        `INSERT INTO rule_results (
            audit_session_id,
            tenant_id,
            rule_id,
            category,
            severity,
            result,
            message,
            remediation,
            evidence_json,
            execution_time_ms
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3,
            $4::rule_category,
            $5::rule_severity,
            $6::rule_result_status,
            $7,
            $8,
            $9::jsonb,
            $10
          )`,
        [
          auditSessionId,
          params.tenantId,
          result.ruleId,
          result.category,
          result.severity,
          result.result,
          result.message,
          result.remediation,
          JSON.stringify(result.evidence ?? {}),
          Math.round(result.executionTimeMs),
        ],
      );
    }

    await this.pool.query(
      `UPDATE claims
          SET last_audit_session_id = $2::uuid,
              updated_at = now()
        WHERE id = $1::uuid`,
      [params.claimId, auditSessionId],
    );

    await this.stateMachine.transitionClaim({
      claimId: params.claimId,
      tenantId: params.tenantId,
      toStatus: ClaimStatus.AUDIT_COMPLETE,
      userId: params.userId,
      metadata: {
        decision: evaluation.decision,
        auditSessionId,
      },
    });

    await this.pool.query(
      `INSERT INTO audit_trail (
          tenant_id,
          claim_id,
          user_id,
          action,
          detail_json
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'AUDIT_COMPLETED'::audit_action,
          $4::jsonb
        )`,
      [
        params.tenantId,
        params.claimId,
        params.userId,
        JSON.stringify({
          auditSessionId,
          decision: evaluation.decision,
          totalRules: evaluation.totalRules,
          executionTimeMs: Math.round(evaluation.executionTimeMs),
        }),
      ],
    );

    await this.emitClaimFlagged({
      tenantId: params.tenantId,
      claimId: params.claimId,
      auditSessionId,
      decision: evaluation.decision,
      payerSlug: payer.slug,
    });

    return this.getAuditById({
      auditId: auditSessionId,
      tenantId: params.tenantId,
    });
  }

  /**
   * Document-less structured scoring for the public `/v1/claims/score` endpoint.
   * Evaluates the claim's structured fields against its payer's rulepack (no ML /
   * documents — document-dependent rules deterministically return INCOMPLETE),
   * persists an audit session (recording payer + rulepack version), and returns it.
   * Fails closed when the payer has no authoritative rulepack.
   */
  async scoreClaimStructured(params: ExecuteAuditPipelineParams): Promise<AuditSessionResult> {
    const locale = params.locale ?? 'en';
    const startedAt = new Date();

    const claim = await this.loadClaimContext(params.claimId, params.tenantId);
    const payer = this.resolveClaimPayer(claim.row);
    const engine = this.engineRegistry.getEngineForPayer({
      slug: payer.slug,
      rulepackVersion: payer.rulepackVersion,
    });

    const registryResults = await this.fetchRegistryDataStub(claim.row);
    const tariffs = await this.loadActiveTariffs();

    const input: RuleEngineInput = {
      claim: {
        id: claim.row.id,
        claimType: claim.row.claim_type,
        tenantId: claim.row.tenant_id,
        facilityId: claim.row.facility_id,
        admissionDate: toDateOnly(claim.row.admission_date),
        dischargeDate: claim.row.discharge_date ? toDateOnly(claim.row.discharge_date) : null,
        patientShaId: claim.row.patient_sha_id,
        patientName: claim.row.patient_name_enc,
        patientNationalId: claim.row.patient_national_id_enc,
        primaryDiagnosisCode: claim.row.primary_diagnosis_code,
        lines: claim.lines.map((line) => ({
          id: line.id,
          claimId: line.claim_id,
          lineNumber: line.line_number,
          shaServiceCode: line.sha_service_code,
          description: line.description,
          icdCode: line.icd_code,
          procedureCode: line.procedure_code,
          caseCode: line.case_code,
          quantity: line.quantity,
          unitPrice: toNumber(line.unit_price) ?? 0,
          totalAmount: toNumber(line.total_amount) ?? 0,
          billAmount: toNumber(line.bill_amount),
          preauthNumber: line.preauth_number,
          status: line.status,
          validationNotes: line.validation_notes,
          createdAt: toIso(line.created_at) ?? new Date().toISOString(),
        })),
      },
      extractedFields: new Map(),
      documents: [],
      facilityContext: {
        facilityId: claim.row.facility_id,
        facilityCode: claim.row.facility_sha_code ?? undefined,
        facilityTier: claim.row.facility_tier ?? undefined,
      },
      tariffs,
      registryResults,
    };

    const evaluation = await engine.evaluate(input, locale);

    const counts = {
      passed: evaluation.results.filter((result) => result.result === RuleResultStatus.PASS).length,
      failed: evaluation.results.filter((result) => result.result === RuleResultStatus.FAIL).length,
      warning: evaluation.results.filter((result) => result.result === RuleResultStatus.WARNING).length,
      incomplete: evaluation.results.filter((result) => result.result === RuleResultStatus.INCOMPLETE).length,
      skipped: evaluation.results.filter((result) => result.result === RuleResultStatus.SKIPPED).length,
    };

    const deterministicScore = evaluation.totalRules > 0 ? counts.passed / evaluation.totalRules : 0;
    const rulepackVersion = evaluation.rulepackVersion ?? engine.activeVersion;
    const loaderPayerSlug = payer.slug === DEFAULT_PAYER_SLUG ? undefined : payer.slug;
    const rulepackChecksum = await this.resolveRulepackChecksum(rulepackVersion, loaderPayerSlug);

    const sessionInsert = await this.pool.query<{ id: string }>(
      `INSERT INTO audit_sessions (
          claim_id, tenant_id, user_id, rulepack_version, rulepack_checksum, decision,
          total_rules, passed_count, failed_count, warning_count, incomplete_count,
          skipped_count, deterministic_score, ml_quality_score, fix_report_md,
          execution_time_ms, started_at, completed_at, payer_id, payer_slug
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::audit_decision,
          $7, $8, $9, $10, $11,
          $12, $13, NULL, $14,
          $15, $16::timestamptz, now(), $17::uuid, $18
        )
        RETURNING id`,
      [
        params.claimId,
        params.tenantId,
        params.userId,
        rulepackVersion,
        rulepackChecksum,
        evaluation.decision,
        evaluation.totalRules,
        counts.passed,
        counts.failed,
        counts.warning,
        counts.incomplete,
        counts.skipped,
        deterministicScore,
        evaluation.fixReportMarkdown,
        Math.round(evaluation.executionTimeMs),
        startedAt.toISOString(),
        payer.id,
        payer.slug,
      ],
    );

    const auditSessionId = sessionInsert.rows[0]?.id;

    if (!auditSessionId) {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, 'Failed to create audit session');
    }

    for (const result of evaluation.results) {
      await this.pool.query(
        `INSERT INTO rule_results (
            audit_session_id, tenant_id, rule_id, category, severity, result,
            message, remediation, evidence_json, execution_time_ms
          ) VALUES (
            $1::uuid, $2::uuid, $3, $4::rule_category, $5::rule_severity, $6::rule_result_status,
            $7, $8, $9::jsonb, $10
          )`,
        [
          auditSessionId,
          params.tenantId,
          result.ruleId,
          result.category,
          result.severity,
          result.result,
          result.message,
          result.remediation,
          JSON.stringify(result.evidence ?? {}),
          Math.round(result.executionTimeMs),
        ],
      );
    }

    await this.pool.query(
      `UPDATE claims SET last_audit_session_id = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
      [params.claimId, auditSessionId],
    );

    await this.pool.query(
      `INSERT INTO audit_trail (tenant_id, claim_id, user_id, action, detail_json)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'AUDIT_COMPLETED'::audit_action, $4::jsonb)`,
      [
        params.tenantId,
        params.claimId,
        params.userId,
        JSON.stringify({ source: 'score', auditSessionId, decision: evaluation.decision }),
      ],
    );

    await this.emitClaimFlagged({
      tenantId: params.tenantId,
      claimId: params.claimId,
      auditSessionId,
      decision: evaluation.decision,
      payerSlug: payer.slug,
    });

    return this.getAuditById({ auditId: auditSessionId, tenantId: params.tenantId });
  }

  async getLatestAuditForClaim(params: FindLatestAuditParams): Promise<AuditSessionResult> {
    const sessionResult = await this.pool.query<AuditSessionRow>(
      `SELECT a.*
         FROM audit_sessions a
         JOIN claims c ON c.id = a.claim_id
        WHERE a.claim_id = $1::uuid
          AND c.tenant_id = $2::uuid
        ORDER BY a.started_at DESC
        LIMIT 1`,
      [params.claimId, params.tenantId],
    );

    const session = sessionResult.rows[0];

    if (!session) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Audit session not found');
    }

    return this.mapAuditSessionWithResults(session);
  }

  async getAuditById(params: FindAuditByIdParams): Promise<AuditSessionResult> {
    const sessionResult = await this.pool.query<AuditSessionRow>(
      `SELECT a.*
         FROM audit_sessions a
         JOIN claims c ON c.id = a.claim_id
        WHERE a.id = $1::uuid
          AND c.tenant_id = $2::uuid
        LIMIT 1`,
      [params.auditId, params.tenantId],
    );

    const session = sessionResult.rows[0];

    if (!session) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Audit session not found');
    }

    return this.mapAuditSessionWithResults(session);
  }

  private async processDocument(document: DocumentRow): Promise<ProcessedDocumentOutcome> {
    await this.pool.query(
      `UPDATE documents
          SET processing_status = 'PROCESSING'::doc_processing_status,
              processing_error = NULL
        WHERE id = $1::uuid`,
      [document.id],
    );

    try {
      const response = await this.mlClient.processDocument({
        documentId: document.id,
        storagePath: document.storage_path,
        docType: document.doc_type as never,
        processingRoute: document.processing_route as never,
      });

      return this.persistDocumentProcessingResult(document, response);
    } catch (error) {
      await this.pool.query(
        `UPDATE documents
            SET processing_status = 'FAILED'::doc_processing_status,
                processing_error = $2
          WHERE id = $1::uuid`,
        [
          document.id,
          error instanceof Error ? error.message.slice(0, 1000) : 'document_processing_failed',
        ],
      );

      await this.pool.query(
        `UPDATE document_pages
            SET status = 'FAILED'::doc_processing_status,
                error_message = COALESCE(error_message, 'ML processing failed'),
                processed_at = now()
          WHERE document_id = $1::uuid`,
        [document.id],
      );

      throw error;
    }
  }

  private async persistDocumentProcessingResult(
    document: DocumentRow,
    response: MlProcessDocumentResponse,
  ): Promise<ProcessedDocumentOutcome> {
    const pageMap = new Map<number, MlPageResult>();

    for (const page of response.pages ?? []) {
      pageMap.set(page.page_number, page);
    }

    const extractedFields: NormalizedExtractedField[] = [];
    const qualityScores: number[] = [];
    const textSegments: string[] = [];

    let anyFailed = false;
    let signaturePresent = false;
    let stampPresent = false;

    for (let pageNumber = 1; pageNumber <= document.page_count; pageNumber += 1) {
      const page = pageMap.get(pageNumber);

      if (!page || page.status === 'FAILED') {
        anyFailed = true;

        await this.pool.query(
          `UPDATE document_pages
              SET status = 'FAILED'::doc_processing_status,
                  error_message = $3,
                  processed_at = now()
            WHERE document_id = $1::uuid
              AND page_number = $2`,
          [document.id, pageNumber, page?.error ?? 'No processing result returned'],
        );

        continue;
      }

      const qualityScore = typeof page.quality?.score === 'number' ? page.quality.score : null;
      const ocrConfidence = typeof page.ocr?.overall_confidence === 'number' ? page.ocr.overall_confidence : null;
      const ocrEngine = typeof page.ocr?.engine === 'string' ? page.ocr.engine : null;

      if (qualityScore !== null) {
        qualityScores.push(qualityScore);
      }

      if (typeof page.ocr?.raw_text === 'string' && page.ocr.raw_text.trim().length > 0) {
        textSegments.push(page.ocr.raw_text);

        await this.pool.query(
          `INSERT INTO ocr_text (
              document_id,
              page_number,
              raw_text,
              engine,
              overall_confidence,
              word_count
            ) VALUES (
              $1::uuid,
              $2,
              $3,
              $4,
              $5,
              $6
            )
            ON CONFLICT (document_id, page_number, engine)
            DO UPDATE SET
              raw_text = EXCLUDED.raw_text,
              overall_confidence = EXCLUDED.overall_confidence,
              word_count = EXCLUDED.word_count`,
          [
            document.id,
            pageNumber,
            page.ocr.raw_text,
            ocrEngine ?? 'unknown',
            ocrConfidence ?? 0,
            page.ocr.word_count ?? 0,
          ],
        );
      }

      await this.pool.query(
        `UPDATE document_pages
            SET status = 'COMPLETED'::doc_processing_status,
                ocr_engine_used = $3,
                overall_confidence = $4,
                image_quality_score = $5,
                error_message = NULL,
                processed_at = now()
          WHERE document_id = $1::uuid
            AND page_number = $2`,
        [document.id, pageNumber, ocrEngine, ocrConfidence, qualityScore],
      );

      if (page.signature?.present === true) {
        signaturePresent = true;
      }

      if (page.signature?.type === 'STAMP' && page.signature?.present === true) {
        stampPresent = true;
      }

      for (const rawField of page.extracted_fields ?? []) {
        const normalized = normalizeField(rawField, pageNumber);

        if (!normalized) {
          continue;
        }

        normalized.documentId = document.id;
        extractedFields.push(normalized);
      }
    }

    for (const aggregated of response.aggregated_fields ?? []) {
      const normalized = normalizeField(aggregated, 1);

      if (!normalized) {
        continue;
      }

      normalized.documentId = document.id;
      extractedFields.push(normalized);
    }

    if (signaturePresent) {
      extractedFields.push({
        key: 'physician_signature_present',
        value: true,
        confidence: 0.9,
        documentId: document.id,
        pageNumber: 1,
        bbox: null,
      });
    }

    if (stampPresent) {
      extractedFields.push({
        key: 'physician_stamp_present',
        value: true,
        confidence: 0.85,
        documentId: document.id,
        pageNumber: 1,
        bbox: null,
      });
    }

    const processingStatus = anyFailed || response.status === 'PARTIAL'
      ? 'MANUAL_ENTRY_REQUIRED'
      : 'COMPLETED';

    await this.pool.query(
      `UPDATE documents
          SET processing_status = $2::doc_processing_status,
              processing_error = $3
        WHERE id = $1::uuid`,
      [
        document.id,
        processingStatus,
        anyFailed ? 'One or more pages failed ML processing' : null,
      ],
    );

    const averageQuality = qualityScores.length > 0
      ? qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length
      : null;

    return {
      document: {
        id: document.id,
        docType: document.doc_type as never,
        pageCount: document.page_count,
        processingStatus: processingStatus as never,
        textContent: textSegments.join('\n'),
        metadata: {
          imageQualityScore: averageQuality,
          signature_present: signaturePresent,
          physician_signature_present: signaturePresent,
          physician_stamp_present: stampPresent,
          classification: response.pages[0]?.classification ?? null,
        },
      },
      extractedFields,
      qualityScores,
    };
  }

  private async persistExtractedFields(claimId: string, tenantId: string, fields: NormalizedExtractedField[]): Promise<void> {
    await this.pool.query(
      `DELETE FROM extracted_fields
        WHERE claim_id = $1::uuid
          AND source = 'OCR'`,
      [claimId],
    );

    for (const field of fields) {
      const tier = determineConfidenceTier(
        field.confidence,
        this.config.CONF_THRESHOLD_HIGH,
        this.config.CONF_THRESHOLD_LOW,
      );

      await this.pool.query(
        `INSERT INTO extracted_fields (
            claim_id,
            tenant_id,
            document_id,
            page_number,
            field_key,
            field_value,
            confidence,
            confidence_tier,
            bbox_json,
            source,
            needs_review,
            reviewed
          ) VALUES (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4,
            $5,
            $6,
            $7,
            $8::field_confidence_tier,
            $9::jsonb,
            'OCR',
            $10,
            false
          )`,
        [
          claimId,
          tenantId,
          field.documentId,
          field.pageNumber,
          field.key,
          field.value === null ? null : String(field.value),
          field.confidence,
          tier,
          field.bbox ? JSON.stringify(field.bbox) : null,
          field.confidence < this.config.CONF_THRESHOLD_HIGH,
        ],
      );
    }
  }

  private toExtractedFieldMap(fields: NormalizedExtractedField[]): Map<string, ExtractedFieldValue> {
    const map = new Map<string, ExtractedFieldValue>();

    for (const field of fields) {
      const existing = map.get(field.key);

      if (existing && typeof existing.confidence === 'number' && existing.confidence >= field.confidence) {
        continue;
      }

      map.set(field.key, {
        key: field.key,
        value: field.value,
        confidence: field.confidence,
        documentId: field.documentId,
        pageNumber: field.pageNumber,
        bbox: field.bbox ?? undefined,
      });
    }

    return map;
  }

  private async fetchRegistryDataStub(claim: ClaimContextRow): Promise<RegistryLookupResults> {
    try {
      return await this.registryCircuitBreaker.execute(async () => {
        throw new Error('Registry integration is not configured in this environment');
      });
    } catch (error) {
      this.logger.warn(
        {
          claimId: claim.id,
          reason: error instanceof Error ? error.message : 'registry_unavailable',
        },
        'registry lookup unavailable, continuing with incomplete registry data',
      );

      return {
        available: false,
      };
    }
  }

  private async loadActiveTariffs(): Promise<TariffLookup> {
    const rows = await this.pool.query<TariffRow>(
      `SELECT
          t.sha_service_code,
          t.facility_tier,
          t.max_amount_kes,
          t.benefit_package
        FROM tariffs t
        JOIN tariff_versions tv ON tv.id = t.tariff_version_id
       WHERE tv.is_active = true
         AND t.effective_from <= CURRENT_DATE
         AND (t.effective_to IS NULL OR t.effective_to >= CURRENT_DATE)`,
    );

    const byServiceCode: Record<string, TariffRecord[]> = {};

    for (const row of rows.rows) {
      const key = row.sha_service_code;
      const entry: TariffRecord = {
        serviceCode: row.sha_service_code,
        facilityTier: row.facility_tier ?? 'ALL',
        maxAmount: toNumber(row.max_amount_kes) ?? 0,
        packageCode: row.benefit_package,
        active: true,
      };

      if (!byServiceCode[key]) {
        byServiceCode[key] = [];
      }

      byServiceCode[key].push(entry);
    }

    return {
      byServiceCode,
      getTariff: (serviceCode: string, facilityTier: string): TariffRecord | null => {
        const candidates = byServiceCode[serviceCode] ?? [];

        if (candidates.length === 0) {
          return null;
        }

        const tierMatch = candidates.find(
          (candidate) => candidate.facilityTier.toUpperCase() === facilityTier.toUpperCase(),
        );

        if (tierMatch) {
          return tierMatch;
        }

        return candidates.find((candidate) => candidate.facilityTier === 'ALL') ?? candidates[0] ?? null;
      },
    };
  }

  /**
   * Emit a `claim.flagged` webhook event when an audit decision is not PASSED.
   * Best-effort: a webhook failure never fails the audit. The payload is
   * public-safe (no rule internals).
   */
  private async emitClaimFlagged(params: {
    tenantId: string;
    claimId: string;
    auditSessionId: string;
    decision: AuditDecision | null;
    payerSlug: string;
  }): Promise<void> {
    if (params.decision === null || params.decision === AuditDecision.PASSED) {
      return;
    }

    try {
      await this.webhookService.enqueueEvent(this.pool, params.tenantId, WebhookEventType.CLAIM_FLAGGED, {
        claimId: params.claimId,
        auditId: params.auditSessionId,
        payerSlug: params.payerSlug,
        decision: params.decision,
      });
    } catch (error) {
      this.logger.warn({ err: error, claimId: params.claimId }, 'failed to enqueue claim.flagged webhook');
    }
  }

  private async resolveRulepackChecksum(version: string, payerSlug?: string): Promise<string> {
    try {
      const loaded = await loadRulepack(this.config.RULEPACK_DIR, version, payerSlug);
      return loaded.manifest.checksum;
    } catch {
      return '';
    }
  }

  /**
   * Resolve the payer to audit a claim against. Fails closed when the payer has no
   * authoritative rulepack (status not ACTIVE, or no rulepack version) so a claim
   * is never adjudicated against non-authoritative or absent rules.
   */
  private resolveClaimPayer(row: ClaimContextRow): {
    id: string | null;
    slug: string;
    rulepackVersion: string;
  } {
    const slug = row.payer_slug ?? DEFAULT_PAYER_SLUG;
    const version = row.payer_rulepack_version;

    if (row.payer_status !== 'ACTIVE' || !version) {
      throw new DomainError(
        ErrorCode.INVALID_STATE_TRANSITION,
        `Payer '${slug}' is not active for auditing (no authoritative rulepack)`,
      );
    }

    return { id: row.payer_id, slug, rulepackVersion: version };
  }

  private async mapAuditSessionWithResults(session: AuditSessionRow): Promise<AuditSessionResult> {
    const ruleResults = await this.pool.query<RuleResultRow>(
      `SELECT *
         FROM rule_results
        WHERE audit_session_id = $1::uuid
        ORDER BY created_at ASC, id ASC`,
      [session.id],
    );

    return {
      auditSession: {
        id: session.id,
        claimId: session.claim_id,
        userId: session.user_id,
        rulepackVersion: session.rulepack_version,
        rulepackChecksum: session.rulepack_checksum,
        payerId: session.payer_id,
        payerSlug: session.payer_slug,
        decision: session.decision,
        totalRules: session.total_rules,
        passedCount: session.passed_count,
        failedCount: session.failed_count,
        warningCount: session.warning_count,
        incompleteCount: session.incomplete_count,
        skippedCount: session.skipped_count,
        deterministicScore: session.deterministic_score,
        mlQualityScore: session.ml_quality_score,
        fixReportMd: session.fix_report_md,
        executionTimeMs: session.execution_time_ms,
        startedAt: toIso(session.started_at) ?? new Date().toISOString(),
        completedAt: toIso(session.completed_at),
      },
      ruleResults: ruleResults.rows.map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        category: row.category,
        severity: row.severity,
        result: row.result,
        message: row.message,
        remediation: row.remediation,
        evidence: row.evidence_json,
        executionTimeMs: row.execution_time_ms,
        createdAt: toIso(row.created_at) ?? new Date().toISOString(),
      })),
    };
  }

  private async loadClaimContext(claimId: string, tenantId: string): Promise<{
    row: ClaimContextRow;
    lines: ClaimLineRow[];
    documents: DocumentRow[];
  }> {
    const claimResult = await this.pool.query<ClaimContextRow>(
      `SELECT
          c.id,
          c.tenant_id,
          c.facility_id,
          c.status,
          c.claim_type,
          c.admission_date,
          c.discharge_date,
          c.patient_sha_id,
          c.patient_name_enc,
          c.patient_national_id_enc,
          c.primary_diagnosis_code,
          c.visit_type,
          c.hmis_ref,
          f.sha_facility_code AS facility_sha_code,
          f.tier_level AS facility_tier,
          COALESCE(p.id, sha.id) AS payer_id,
          COALESCE(p.slug, sha.slug) AS payer_slug,
          COALESCE(p.status, sha.status)::text AS payer_status,
          COALESCE(p.rulepack_version, sha.rulepack_version) AS payer_rulepack_version
        FROM claims c
        JOIN facilities f ON f.id = c.facility_id
        LEFT JOIN payers p ON p.id = c.payer_id
        LEFT JOIN payers sha ON sha.slug = 'sha'
       WHERE c.id = $1::uuid
         AND c.tenant_id = $2::uuid
       LIMIT 1`,
      [claimId, tenantId],
    );

    const row = claimResult.rows[0];

    if (!row) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Claim not found');
    }

    const lines = await this.pool.query<ClaimLineRow>(
      `SELECT *
         FROM claim_lines
        WHERE claim_id = $1::uuid
        ORDER BY line_number ASC`,
      [claimId],
    );

    const documents = await this.pool.query<DocumentRow>(
      `SELECT *
         FROM documents
        WHERE claim_id = $1::uuid
        ORDER BY uploaded_at ASC`,
      [claimId],
    );

    return {
      row,
      lines: lines.rows,
      documents: documents.rows,
    };
  }
}

export function createAuditPipelineService(
  pool: TenantDb,
  logger: FastifyBaseLogger,
  config: Config,
  dependencies: AuditPipelineDependencies = {},
): AuditPipelineService {
  return new AuditPipelineService(pool, logger, config, dependencies);
}

