import {
  type Claim,
  type ClaimLine,
  type ClaimType,
  DocProcessingStatus,
  type Document,
  type DocumentPage,
  DocumentType,
  type RuleCategory,
  type RuleEvidence,
  type RuleResult,
  type RuleResultStatus,
  type Rulepack,
  type AuditDecision,
} from '@claimflow/shared';

export interface ClaimSnapshot extends Partial<Claim> {
  id: string;
  claimType: ClaimType;
  tenantId: string;
  facilityId: string;
  lines?: ClaimLine[];
}

export interface ExtractedFieldValue {
  key: string;
  value: string | number | boolean | null;
  confidence?: number;
  documentId?: string;
  pageNumber?: number;
  bbox?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

export interface DocumentSummary extends Partial<Document> {
  id: string;
  docType: DocumentType;
  pageCount?: number;
  processingStatus?: DocProcessingStatus;
  pages?: Array<Partial<DocumentPage>>;
  textContent?: string;
  metadata?: Record<string, unknown>;
}

export interface FacilityContext {
  facilityId: string;
  facilityCode?: string;
  facilityName?: string;
  facilityTier?: string;
  county?: string;
  level?: string;
  [key: string]: unknown;
}

export interface TariffRecord {
  serviceCode: string;
  facilityTier: string;
  maxAmount: number;
  packageCode?: string;
  benefitPackage?: string;
  active?: boolean;
  requiresPreauth?: boolean;
}

export interface TariffLookup {
  byServiceCode?: Record<string, TariffRecord[]>;
  getTariff?: (serviceCode: string, facilityTier: string) => TariffRecord | null;
}

export interface IcdCodeLookup {
  isValidCode: (code: string) => boolean;
  isLeafCode: (code: string) => boolean;
}

export interface RegistryPatientResult {
  found?: boolean;
  eligible?: boolean;
  name?: string;
}

export interface RegistryFacilityResult {
  found?: boolean;
  code?: string;
  tier?: string;
}

export interface RegistryPractitionerResult {
  found?: boolean;
  licenseExpiryDate?: string;
  specialty?: string;
}

export interface RegistryLookupResults {
  patient?: RegistryPatientResult;
  facility?: RegistryFacilityResult;
  practitioner?: RegistryPractitionerResult;
  available?: boolean;
}

export interface RuleEngineInput {
  claim: ClaimSnapshot;
  extractedFields: Map<string, ExtractedFieldValue>;
  documents: DocumentSummary[];
  facilityContext: FacilityContext;
  tariffs: TariffLookup;
  icdLookup?: IcdCodeLookup;
  registryResults: RegistryLookupResults;
}

export interface RuleLogicOutput {
  result: RuleResultStatus;
  evidence?: RuleEvidence;
}

export type RuleLogicFn = (
  input: RuleEngineInput,
  params: Record<string, unknown>,
) => RuleLogicOutput;

export interface EvaluatedRuleResult extends RuleResult {
  executionTimeMs: number;
}

export interface RuleEngineOutput {
  decision: AuditDecision;
  totalRules: number;
  results: EvaluatedRuleResult[];
  fixReportMarkdown: string;
  executionTimeMs: number;
  rulepackVersion?: string;
}

export interface RulepackEvaluationContext {
  locale: string;
  category: RuleCategory;
}

export type RulepackLike = Rulepack;
