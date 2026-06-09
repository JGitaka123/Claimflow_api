# AUTO-GENERATED from docs/openapi.yaml by scripts/generate-sdks.sh — DO NOT EDIT.

from __future__ import annotations

from datetime import date
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID

from pydantic import (
    AnyUrl,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    conint,
    constr,
)


class Meta(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )
    requestId: str | None = None
    cursor: str | None = None
    hasMore: bool | None = None
    total: int | None = None


class ApiErrorDetail(BaseModel):
    code: str
    message: str
    field: str | None = None
    detail: dict[str, Any] | None = None


class EnvelopeErrorBody(BaseModel):
    errors: list[ApiErrorDetail]
    meta: Meta | None = None


class EnvelopeObject(BaseModel):
    data: dict[str, Any]
    meta: Meta | None = None


class EnvelopeObjectList(BaseModel):
    data: list[dict[str, Any]]
    meta: Meta | None = None


class Problem(BaseModel):
    type: str
    title: str
    status: int
    detail: str | None = None
    code: str | None = None
    instance: str | None = None
    meta: Meta | None = None
    errors: list[ApiErrorDetail] | None = None


class ClaimType(StrEnum):
    OUTPATIENT = "OUTPATIENT"
    INPATIENT = "INPATIENT"
    EMERGENCY = "EMERGENCY"
    MATERNITY = "MATERNITY"
    DENTAL = "DENTAL"
    OPTICAL = "OPTICAL"


class PayerStatus(StrEnum):
    ACTIVE = "ACTIVE"
    COMING_SOON = "COMING_SOON"
    INACTIVE = "INACTIVE"


class CaseStatus(StrEnum):
    OPEN = "OPEN"
    IN_REVIEW = "IN_REVIEW"
    ESCALATED = "ESCALATED"
    RESOLVED = "RESOLVED"
    CLOSED = "CLOSED"
    DISMISSED = "DISMISSED"


class CasePriority(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class RiskLevel(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class RecommendedAction(StrEnum):
    READY_FOR_SUBMISSION = "READY_FOR_SUBMISSION"
    REVIEW_RECOMMENDED = "REVIEW_RECOMMENDED"
    FIX_REQUIRED = "FIX_REQUIRED"
    DO_NOT_SUBMIT = "DO_NOT_SUBMIT"


class LoginRequest(BaseModel):
    tenantSlug: str
    email: EmailStr
    password: str


class MfaVerifyRequest(BaseModel):
    mfaToken: str
    code: str


class ChangePasswordRequest(BaseModel):
    currentPassword: str
    newPassword: constr(min_length=12)


class AuthenticatedUser(BaseModel):
    id: UUID | None = None
    tenantId: UUID | None = None
    facilityId: UUID | None = None
    email: str | None = None
    displayName: str | None = None
    role: str | None = None
    mustChangePassword: bool | None = None


class LoginResult(BaseModel):
    requiresMfa: bool | None = None
    mfaToken: str | None = None
    accessToken: str | None = None
    refreshToken: str | None = None
    user: AuthenticatedUser | None = None


class EnvelopeLoginResult(BaseModel):
    data: LoginResult
    meta: Meta | None = None


class EnvelopeAuthenticatedUser(BaseModel):
    data: AuthenticatedUser
    meta: Meta | None = None


class ClaimLineInput(BaseModel):
    shaServiceCode: str
    description: str
    icdCode: str | None = None
    procedureCode: str | None = None
    caseCode: str | None = None
    quantity: float
    unitPrice: float
    billAmount: float | None = None


class CreateClaimRequest(BaseModel):
    facilityId: UUID
    payerId: UUID | None = None
    claimType: ClaimType
    visitType: str | None = None
    patientShaId: str | None = None
    patientName: str | None = None
    patientNationalId: str | None = None
    hmisRef: str | None = None
    admissionDate: date
    dischargeDate: date | None = None
    primaryDiagnosisCode: str | None = None
    shaBenefitPackage: str | None = None
    preauthNumber: str | None = None
    lines: list[ClaimLineInput]


class UpdateClaimRequest(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )


class ClaimSummary(BaseModel):
    id: UUID | None = None
    status: str | None = None
    version: int | None = None
    payerId: UUID | None = None
    payerSlug: str | None = None
    claimType: ClaimType | None = None
    visitType: str | None = None
    hmisRef: str | None = None
    patientShaId: str | None = None
    admissionDate: str | None = None
    primaryDiagnosisCode: str | None = None
    documentCount: int | None = None
    lineCount: int | None = None
    lastAuditDecision: str | None = None
    totalAmount: float | None = None
    createdAt: str | None = None
    updatedAt: str | None = None


class EnvelopeClaimSummaryList(BaseModel):
    data: list[ClaimSummary]
    meta: Meta | None = None


class Data(BaseModel):
    claim: dict[str, Any] | None = None
    lines: list[dict[str, Any]] | None = None


class EnvelopeClaimWithLines(BaseModel):
    data: Data
    meta: Meta | None = None


class Data1(BaseModel):
    claim: dict[str, Any] | None = None
    lines: list[dict[str, Any]] | None = None
    documents: list[dict[str, Any]] | None = None
    latestAuditSession: dict[str, Any] | None = None


class EnvelopeClaimDetail(BaseModel):
    data: Data1
    meta: Meta | None = None


class Filter(BaseModel):
    payerId: UUID | None = None
    status: str | None = None


class BatchAuditRequest(BaseModel):
    claimIds: list[UUID] | None = None
    filter: Filter | None = None
    concurrency: conint(ge=1, le=16) | None = None


class Data2(BaseModel):
    jobId: str | None = None
    status: str | None = None
    createdAt: str | None = None
    totalClaims: int | None = None
    claimId: str | None = None
    auditSessionId: str | None = None


class EnvelopeJobAccepted(BaseModel):
    data: Data2
    meta: Meta | None = None


class OverrideRequest(BaseModel):
    reason: constr(min_length=10, max_length=2000)


class Identifier(BaseModel):
    system: str | None = None
    value: str | None = None


class Patient(BaseModel):
    identifier: Identifier | None = None
    display: str | None = None


class BillablePeriod(BaseModel):
    start: str | None = None
    end: str | None = None


class FhirClaimResource(BaseModel):
    resourceType: Literal["Claim"]
    use: str | None = None
    patient: Patient | None = None
    type: dict[str, Any] | None = None
    billablePeriod: BillablePeriod | None = None
    diagnosis: list[dict[str, Any]] | None = None
    item: list[dict[str, Any]] | None = None


class ScoreClaimRequest(BaseModel):
    facilityId: UUID
    payerId: UUID | None = None
    claim: FhirClaimResource


class ScoreFlag(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    reasonCode: str = Field(..., description="ClaimFlow taxonomy, e.g. CF-FIN-021")
    category: str
    severity: str
    message: str = Field(
        ..., description="Short public description — no thresholds or rule internals"
    )
    auditorGeneralTypology: str | None = None


class ClaimScoreCounts(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    failed: int | None = None
    warning: int | None = None
    incomplete: int | None = None
    passed: int | None = None


class Payer(BaseModel):
    slug: str | None = None
    name: str | None = None


class ClaimScoreResult(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    claimId: UUID
    auditId: UUID
    payer: Payer | None = None
    riskLevel: RiskLevel
    recommendedAction: RecommendedAction
    flags: list[ScoreFlag]
    counts: ClaimScoreCounts


class EnvelopeClaimScoreResult(BaseModel):
    data: ClaimScoreResult
    meta: Meta | None = None


class BatchSubmitRequest(BaseModel):
    claims: list[ScoreClaimRequest] = Field(..., max_length=200, min_length=1)


class Status(StrEnum):
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    COMPLETED_WITH_ERRORS = "COMPLETED_WITH_ERRORS"
    FAILED = "FAILED"


class ClaimBatchAccepted(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    batchId: UUID
    status: Status
    totalClaims: int
    createdAt: str


class EnvelopeClaimBatchAccepted(BaseModel):
    data: ClaimBatchAccepted
    meta: Meta | None = None


class Status1(StrEnum):
    QUEUED = "QUEUED"
    SCORED = "SCORED"
    FAILED = "FAILED"


class ClaimBatchItem(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    index: int
    status: Status1
    claimId: UUID | None = None
    score: ClaimScoreResult | None = None
    errorCode: str | None = None
    errorMessage: str | None = None


class Status2(StrEnum):
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    COMPLETED_WITH_ERRORS = "COMPLETED_WITH_ERRORS"
    FAILED = "FAILED"


class ClaimBatchStatus(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    batchId: UUID
    status: Status2
    totalClaims: int
    processedCount: int
    createdAt: str | None = None
    items: list[ClaimBatchItem]


class EnvelopeClaimBatchStatus(BaseModel):
    data: ClaimBatchStatus
    meta: Meta | None = None


class AuditSummaryFinding(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    ruleId: str
    category: str
    severity: str
    result: str
    message: str = Field(..., description="Short public message — no scores/thresholds")
    remediation: str | None = Field(
        None, description="Staff fix-guidance for this finding"
    )
    evidence: dict[str, Any] | None = Field(
        None, description="Which field / document location the flag concerns"
    )
    auditorGeneralTypology: str | None = None


class AuditSummary(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    auditId: UUID
    claimId: UUID
    payer: Payer | None = None
    decision: str | None
    totalRules: int
    passedCount: int | None = None
    failedCount: int | None = None
    warningCount: int | None = None
    incompleteCount: int | None = None
    skippedCount: int | None = None
    rulepackVersion: str | None = None
    startedAt: str | None = None
    completedAt: str | None = None
    findings: list[AuditSummaryFinding]


class EnvelopeAuditSummary(BaseModel):
    data: AuditSummary
    meta: Meta | None = None


class CorrectFieldRequest(BaseModel):
    value: str
    reason: str | None = None


class CreateCaseRequest(BaseModel):
    title: str
    description: str | None = None
    priority: CasePriority | None = None
    claimIds: list[UUID] | None = None


class UpdateCaseRequest(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )


class TransitionCaseRequest(BaseModel):
    toStatus: CaseStatus
    note: str | None = None


class LinkClaimsRequest(BaseModel):
    claimIds: list[UUID]


class CreatePreauthorizationRequest(BaseModel):
    model_config = ConfigDict(
        extra="allow",
    )


class CreateWebhookRequest(BaseModel):
    url: AnyUrl
    events: list[str]
    description: str | None = None


class CreateApiKeyRequest(BaseModel):
    name: constr(min_length=1, max_length=120)
    scopes: list[str] = Field(..., min_length=1)
    expiresAt: AwareDatetime | None = None


class ApiKey(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    id: UUID | None = None
    tenantId: UUID | None = None
    name: str | None = None
    keyPrefix: str | None = None
    scopes: list[str] | None = None
    createdBy: UUID | None = None
    lastUsedAt: str | None = None
    expiresAt: str | None = None
    revokedAt: str | None = None
    createdAt: str | None = None


class ApiKeyCreated(ApiKey):
    key: str | None = Field(
        None, description="Plaintext key — returned once at creation only"
    )


class EnvelopeApiKeyList(BaseModel):
    data: list[ApiKey]
    meta: Meta | None = None


class EnvelopeApiKeyCreated(BaseModel):
    data: ApiKeyCreated
    meta: Meta | None = None


class CreateOAuthClientRequest(BaseModel):
    name: constr(min_length=1, max_length=120)
    scopes: list[str] = Field(..., min_length=1)


class OAuthTokenRequest(BaseModel):
    grant_type: Literal["client_credentials"]
    client_id: str
    client_secret: str
    scope: str | None = Field(
        None, description="Optional space-delimited subset (down-scoping)"
    )


class OAuthTokenResponse(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    access_token: str
    token_type: Literal["Bearer"]
    expires_in: int
    scope: str


class SessionTokens(BaseModel):
    accessToken: str | None = None
    refreshToken: str | None = None
    user: AuthenticatedUser | None = None


class EnvelopeSessionTokens(BaseModel):
    data: SessionTokens
    meta: Meta | None = None
