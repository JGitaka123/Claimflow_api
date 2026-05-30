# CLAIMFLOW — COMPLETE SPECIFICATION PACKAGE

**Combined Document: All Specifications, Reviews, and Addenda**
**Date:** March 2026
**Version:** 4.0 Final

---


---

# PART 1: DEFINITIVE TECHNICAL SPECIFICATION (v4.0)

---

# CLAIMFLOW — DEFINITIVE TECHNICAL SPECIFICATION

## SHA Claims Documentation Audit Platform

**Version:** 4.0 (Production-Ready)
**Date:** March 2026
**Status:** FINAL — Implementation-Ready for Claude Code

---

## TABLE OF CONTENTS

1. System Purpose & Strategic Objective
2. Success Metrics & SLOs
3. Scope: v1 Ship / v2 / v3
4. Non-Negotiable Constraints
5. Design Principles
6. Architecture & Technology Stack
7. Monorepo Structure
8. Claim Lifecycle State Machine
9. Complete Database Schema (SQL Migrations)
10. Full API Contracts (OpenAPI 3.1)
11. Deterministic Rule Engine
12. Rule Catalog (120 Rules)
13. Document Type Taxonomy & Processing Routes
14. FHIR R4 Mapping & AfyaLink Integration
15. ML Pipeline (CPU-Realistic)
16. Audit Workspace UX Specification
17. Dashboard Specification
18. Authentication & Authorization
19. Encryption & Key Management
20. External Integrations (Registries, Eligibility)
21. Queueing & Workflow Orchestration
22. Storage Architecture
23. Observability & Logging
24. Subscription & Licensing
25. Multi-Tenant Architecture
26. Sync Agent & Hybrid Cloud
27. Onboarding & Facility Setup
28. Backup, Recovery & Data Retention
29. Deployment (Docker Compose)
30. Update & Rollback Procedures
31. Test Strategy
32. Configuration Schema
33. Internationalization (i18n)
34. Security Hardening (Rate Limits, Input Validation)
35. Failure Conditions & Acceptance Gates
36. Build Order for Claude Code
37. Future Roadmap

---

## 1. SYSTEM PURPOSE & STRATEGIC OBJECTIVE

ClaimFlow is a deterministic claims documentation audit platform deployed inside Kenyan hospitals. It verifies SHA (Social Health Authority) claims documentation before submission to the AfyaLink Health Information Exchange (HIE).

ClaimFlow operates as a pre-submission safety layer between hospital HMIS systems and SHA's Centralized Digital Platform. It ensures regulatory compliance, complete clinical documentation, valid patient identity, tariff conformity, and correct claim structure — catching and fixing issues that would cause SHA rejection.

**Strategic Objective:** Reduce documentation-related SHA claim rejections to near zero, becoming the national standard for SHA claim documentation verification across Kenyan hospitals.

**Business Model:** On-premise SaaS with Free and Pro tiers, centrally managed via a hybrid cloud control plane.

---

## 2. SUCCESS METRICS & SLOs

### Primary Success Metric
For claims marked AUDIT_PASSED: achieve <0.1% documentation/admin-related SHA rejection rate over a rolling 30-day window per facility.

### Operational SLOs (realistic for on-prem single-server)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Deterministic audit decision (rules only, given extracted fields) | p95 ≤ 2.0s | Timer from rule engine invocation to result |
| Full pipeline (20 pages: OCR + extraction + rules) | p95 ≤ 20s on reference hardware | Timer from audit trigger to result persistence |
| User claim audit time (human review cycle) | median ≤ 5 minutes | From claim opened to decision recorded |
| OCR word error rate (typed documents) | ≤ 15% | Measured against officer corrections |
| OCR word error rate (handwritten) | ≤ 25% | Measured against officer corrections |
| System uptime (single server) | 99.5% | ~44 hours downtime/year allowed |
| System uptime (with warm standby) | 99.9% | ~8.7 hours downtime/year allowed |
| Degraded mode availability | 100% when ML is down | Manual audit + deterministic rules must always work |

### Reference Hardware (minimum hospital server)
- 8 CPU cores (Intel Xeon or equivalent)
- 32 GB RAM
- 1 TB SSD
- Ubuntu 24.04 LTS
- No GPU required for v1

---

## 3. SCOPE

### v1 (Ship)
- Claims intake with document upload
- OCR + field extraction (CPU-based: Tesseract 5 + PaddleOCR)
- Document classification (lightweight CNN)
- Signature/stamp detection (contour heuristics)
- Image quality validation (blur, skew, DPI)
- Deterministic rule engine with ~120 rules
- Fix report generation (Markdown + PDF)
- Audit workspace with keyboard-first correction UX
- Batch audit ("Audit All Pending")
- Responsibility tracking + append-only audit trail
- Export evidence pack (PDF + JSON + file hashes)
- Dashboard with compliance analytics
- RBAC with JWT + TOTP MFA
- Rulepack versioning (SemVer) with rollback
- Offline-first operation
- Multi-tenant isolation
- Sync agent for rulepack updates + anonymized metrics
- Subscription licensing (Free/Pro)
- i18n: English + Swahili

### NOT in v1
- Automated claim submission to SHA
- FHIR bundle construction/validation (v2)
- Chatbot / LLM-based fix assistance (v2 — requires local LLM for PHI sovereignty)
- Fraud prediction
- Tariff negotiation
- Eligibility verification API integration (v2)

### v2
- SHA shadow validation of FHIR Claim Bundle (local, pre-submission)
- Optional assisted submission flow (human-confirmed)
- Eligibility API integration (AfyaLink)
- Local LLM chatbot for fix guidance (Phi-3 or similar, on-prem only)
- MinIO object storage for multi-node HA

### v3
- Outcome feedback loop: SHA rejection reasons mapped to rule categories
- ML rejection-risk model
- Cross-facility drift detection + active learning with governance
- National claims analytics dashboard (control plane)
- Predictive rejection engine

---

## 4. NON-NEGOTIABLE CONSTRAINTS

### Security & Data Sovereignty
- No PHI in plaintext at rest — database fields, files, and logs must be encrypted.
- Hybrid sync default is METRICS_ONLY — no PHI leaves the hospital.
- Multi-tenant isolation enforced at query level: every query includes tenant_id in WHERE clause.
- All external API calls use TLS 1.3.

### Determinism
- Same claim snapshot (extracted_fields + claim_data) + same rulepack version ⇒ bitwise-identical audit output.
- ML outputs are inputs to the deterministic rule engine; ML never overrides PASS/FAIL.
- The non-deterministic step is extraction (OCR). Once extracted_fields are persisted, all subsequent processing is deterministic.

### Compliance Red Lines
- Claim CANNOT pass if required documents are missing (per rulepack benefit-package mapping).
- Claim CANNOT pass if clinician attestation (signature/stamp) is missing — unless dual-control override with step-up authentication + full audit trail.
- External verification failures (client registry, practitioner registry) handled per rulepack policy: configurable as HARD_STOP or WARNING.

### Regulatory
- Kenya Data Protection Act 2019 compliance: data minimization, purpose limitation, consent management.
- SHA claims must be submitted within 7 days of service/discharge.
- Healthcare providers must maintain documentation for audit by SHA quality assessors.

---

## 5. DESIGN PRINCIPLES

1. **Deterministic first** — Rule engine determines audit outcome. All rules evaluate to PASS/FAIL/WARNING/INCOMPLETE deterministically.
2. **AI assists humans** — ML suggests corrections and extracts data; it never overrides rules. Every ML output has a confidence score.
3. **Offline-first** — Hospital operates fully even if SHA portal, AfyaLink, and internet are unavailable. External lookups degrade gracefully.
4. **On-prem data sovereignty** — PHI never leaves the hospital server. Only anonymized metrics transit to the control plane.
5. **Human-in-the-loop** — Claims officers verify uncertain fields, approve overrides, and make final decisions.
6. **Fail safe** — When in doubt, FAIL the audit. False negatives (incorrect PASS) are catastrophic; false positives (incorrect FAIL) are merely annoying.
7. **Modular monolith** — Single codebase deployed as containers on one server. In-process function calls between modules. Shared database. This is NOT microservices — it's a practical deployment for constrained hospital environments.

---

## 6. ARCHITECTURE & TECHNOLOGY STACK

### Architecture Pattern
Modular monolith deployed as Docker containers on a single hospital server. The only service boundary that crosses a network is the API ↔ ML service boundary (Python process for ML inference, TypeScript for everything else).

### Technology Stack

| Layer | Technology | Justification |
|-------|-----------|---------------|
| Backend API + Rule Engine | TypeScript (Node.js 20 LTS) + Fastify | Single language with frontend; best for rule DSL expressiveness; Claude Code generates TS well |
| Frontend | Next.js 14 (TypeScript) | SSR for dashboard, client-side for audit workspace |
| ML Service | Python 3.11 + FastAPI | ML ecosystem is Python-native; isolated service |
| Database | PostgreSQL 17 | JSON support, logical replication, WAL archiving, mature |
| Job Queue | pg-boss (Postgres-native) | Eliminates RabbitMQ ops burden; sufficient for v1 throughput |
| Document Storage | Local filesystem (v1) | Behind DocumentStore interface; MinIO in v2 |
| Authentication | In-app JWT RS256 + TOTP | Eliminates Keycloak; ~500 lines of code |
| Observability | JSON structured logs + /metrics endpoint | Lightweight; Prometheus/Grafana in v2 |
| Containerization | Docker + Docker Compose | Standard hospital deployment |
| Package Manager | pnpm workspaces | Monorepo management for TypeScript packages |

### Service Topology (Docker Compose)
```
┌─────────────────────────────────────────────────┐
│                Hospital Server                    │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ postgres │  │   api    │  │  ml-service   │  │
│  │  :5432   │  │  :8080   │  │    :8000      │  │
│  │          │◄─┤          │──┤  (Python)     │  │
│  │ pg-boss  │  │ (TS/     │  │  Tesseract    │  │
│  │ jobs     │  │  Fastify)│  │  PaddleOCR    │  │
│  └──────────┘  └────┬─────┘  └──────────────┘  │
│                     │                             │
│              ┌──────┴──────┐                     │
│              │    web      │                     │
│              │   :3000     │                     │
│              │  (Next.js)  │                     │
│              └─────────────┘                     │
│                                                   │
│  ┌──────────────┐   ┌────────────────────────┐  │
│  │  sync-agent  │   │  /data/docs/           │  │
│  │  (periodic)  │   │  /data/exports/        │  │
│  │              │   │  /data/rulepacks/       │  │
│  └──────────────┘   └────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## 7. MONOREPO STRUCTURE

```
claimflow/
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example                    # All config vars with defaults
├── packages/
│   ├── shared/                     # @claimflow/shared
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── claim.ts        # ClaimStatus enum, ClaimLine, etc.
│   │   │   │   ├── document.ts     # DocumentType enum, DocProcessingRoute
│   │   │   │   ├── rule.ts         # RuleSeverity, RuleResult, AuditDecision
│   │   │   │   ├── auth.ts         # Role enum, Permission matrix
│   │   │   │   ├── api.ts          # ApiResponse<T>, ApiError, Cursor
│   │   │   │   └── fhir.ts         # FHIR R4 resource type mappings
│   │   │   ├── constants/
│   │   │   │   ├── claim-states.ts # State machine transitions
│   │   │   │   ├── error-codes.ts  # Domain error taxonomy
│   │   │   │   ├── icd11-codes.ts  # ICD-11 code loader (from bundled DB)
│   │   │   │   └── sha-tariffs.ts  # Tariff lookup interface
│   │   │   ├── validation/
│   │   │   │   └── schemas.ts      # Zod schemas for all API payloads
│   │   │   └── i18n/
│   │   │       ├── en.json
│   │   │       └── sw.json
│   │   └── package.json
│   │
│   ├── rule-engine/                # @claimflow/rule-engine
│   │   ├── src/
│   │   │   ├── engine.ts           # Core: load rulepack, evaluate, return results
│   │   │   ├── loader.ts           # YAML rulepack parser + validator
│   │   │   ├── evaluator.ts        # Rule evaluation with parallel category exec
│   │   │   ├── fix-report.ts       # Markdown + PDF generation from results
│   │   │   ├── rules/              # Built-in rule logic implementations
│   │   │   │   ├── identity.ts
│   │   │   │   ├── documentation.ts
│   │   │   │   ├── clinical.ts
│   │   │   │   ├── authorization.ts
│   │   │   │   ├── financial.ts
│   │   │   │   └── structural.ts
│   │   │   └── types.ts
│   │   ├── __tests__/              # 100% coverage required
│   │   └── package.json
│   │
│   ├── api/                        # @claimflow/api
│   │   ├── src/
│   │   │   ├── server.ts           # Fastify app setup
│   │   │   ├── config.ts           # Typed config loader with validation
│   │   │   ├── plugins/
│   │   │   │   ├── auth.ts         # JWT + TOTP + RBAC plugin
│   │   │   │   ├── tenant.ts       # tenant_id injection middleware
│   │   │   │   ├── rate-limit.ts   # Per-user rate limiting
│   │   │   │   └── error-handler.ts
│   │   │   ├── routes/
│   │   │   │   ├── claims.ts
│   │   │   │   ├── documents.ts
│   │   │   │   ├── audit.ts
│   │   │   │   ├── batch.ts
│   │   │   │   ├── dashboard.ts
│   │   │   │   ├── auth.ts
│   │   │   │   ├── admin.ts
│   │   │   │   └── health.ts
│   │   │   ├── services/
│   │   │   │   ├── claim-service.ts
│   │   │   │   ├── document-service.ts
│   │   │   │   ├── audit-service.ts
│   │   │   │   ├── audit-trail.ts
│   │   │   │   ├── user-service.ts
│   │   │   │   └── export-service.ts
│   │   │   ├── workflows/
│   │   │   │   ├── audit-pipeline.ts   # Orchestrator: extract → rules → persist
│   │   │   │   └── state-machine.ts    # Claim state transitions
│   │   │   ├── integrations/
│   │   │   │   ├── client-registry.ts  # SHA patient lookup + cache
│   │   │   │   ├── facility-registry.ts
│   │   │   │   ├── circuit-breaker.ts
│   │   │   │   └── ml-client.ts        # HTTP client to ML service
│   │   │   ├── storage/
│   │   │   │   ├── document-store.ts   # Interface
│   │   │   │   └── local-fs-store.ts   # v1 implementation
│   │   │   └── db/
│   │   │       ├── client.ts           # Postgres connection pool
│   │   │       └── queries/            # Parameterized SQL queries
│   │   └── package.json
│   │
│   ├── web/                        # @claimflow/web (Next.js)
│   │   ├── src/
│   │   │   ├── app/                # App router
│   │   │   ├── components/
│   │   │   │   ├── claims/
│   │   │   │   ├── audit-workspace/
│   │   │   │   ├── dashboard/
│   │   │   │   └── common/
│   │   │   ├── hooks/
│   │   │   ├── lib/
│   │   │   │   ├── api-client.ts
│   │   │   │   └── i18n.ts         # next-intl setup
│   │   │   └── styles/
│   │   └── package.json
│   │
│   ├── ml-service/                 # Python (NOT in pnpm workspace)
│   │   ├── app/
│   │   │   ├── main.py             # FastAPI app
│   │   │   ├── config.py
│   │   │   ├── routers/
│   │   │   │   ├── ocr.py
│   │   │   │   ├── classify.py
│   │   │   │   ├── signature.py
│   │   │   │   └── quality.py
│   │   │   ├── engines/
│   │   │   │   ├── tesseract.py
│   │   │   │   ├── paddleocr.py
│   │   │   │   └── ensemble.py
│   │   │   ├── models/             # Trained model files (encrypted for Pro)
│   │   │   └── utils/
│   │   ├── requirements.txt
│   │   ├── Dockerfile
│   │   └── tests/
│   │
│   └── sync-agent/                 # @claimflow/sync-agent
│       ├── src/
│       │   ├── agent.ts
│       │   ├── rulepack-sync.ts
│       │   ├── metrics-uploader.ts
│       │   ├── license-validator.ts
│       │   └── software-updater.ts
│       └── package.json
│
├── rulepacks/
│   └── v1.0.0/
│       ├── manifest.yaml
│       ├── identity.yaml
│       ├── documentation.yaml
│       ├── clinical.yaml
│       ├── authorization.yaml
│       ├── financial.yaml
│       └── structural.yaml
│
├── migrations/
│   ├── 001_tenants_facilities.sql
│   ├── 002_users_auth.sql
│   ├── 003_claims.sql
│   ├── 004_documents.sql
│   ├── 005_extraction.sql
│   ├── 006_rulepacks.sql
│   ├── 007_audits.sql
│   ├── 008_audit_trail.sql
│   ├── 009_tariffs.sql
│   ├── 010_jobs_outbox.sql
│   ├── 011_sync.sql
│   ├── 012_icd_codes.sql
│   ├── 013_registry_cache.sql
│   └── 014_indexes.sql
│
├── reference-data/
│   ├── icd11-codes.csv             # WHO ICD-11 code set
│   ├── sha-service-codes.csv       # SHA-specific service codes
│   └── sha-tariffs-2025.csv        # Current tariff schedule
│
├── docker/
│   ├── docker-compose.yml          # v1 minimal
│   ├── docker-compose.enterprise.yml
│   ├── Dockerfile.api
│   ├── Dockerfile.web
│   └── Dockerfile.ml
│
├── scripts/
│   ├── setup.sh                    # First-run hospital setup
│   ├── backup.sh                   # Automated backup script
│   ├── restore.sh                  # Disaster recovery
│   ├── migrate.sh                  # Run DB migrations
│   └── seed-test-data.sh           # Test/training mode data
│
└── tests/
    ├── unit/                       # Per-package, co-located
    ├── integration/                # API + DB integration tests
    │   └── setup.ts                # testcontainers for Postgres
    └── e2e/                        # Playwright browser tests
        ├── claim-lifecycle.spec.ts
        ├── audit-workspace.spec.ts
        └── batch-audit.spec.ts
```

---

## 8. CLAIM LIFECYCLE STATE MACHINE

### States

| State | Description | Who Triggers |
|-------|-------------|-------------|
| `DRAFT` | Claim created, no documents yet | System (on POST /v1/claims) |
| `DOCUMENTS_UPLOADED` | At least one document attached | System (after document upload) |
| `PROCESSING` | OCR/extraction/audit pipeline running | System (on POST /v1/claims/{id}/audit) |
| `AUDIT_COMPLETE` | Pipeline finished — transient state (≤1s) | System (pipeline completion) |
| `PASSED` | All rules passed | System (from AUDIT_COMPLETE) |
| `FAILED` | One or more HARD_STOP rules failed | System (from AUDIT_COMPLETE) |
| `WARNING` | No hard stops, but warnings exist | System (from AUDIT_COMPLETE) |
| `OFFICER_REVIEW` | Officer is reviewing warnings | Officer (opens claim from WARNING) |
| `CORRECTIONS_IN_PROGRESS` | Officer correcting failed claim | Officer (starts corrections on FAILED claim) |
| `OVERRIDE_PENDING` | Override requested, awaiting supervisor | Officer (requests override on FAILED) |
| `OVERRIDE_APPROVED` | Supervisor approved override | Supervisor (approves with reason) |
| `READY_FOR_SUBMISSION` | (v2+) Passed audit, ready for SHA | System/Officer |
| `SUBMITTED` | (v2+) Sent to SHA | System |

### Valid Transitions

```
DRAFT ──────────────────────► DOCUMENTS_UPLOADED
                                      │
                                      ▼
                                 PROCESSING
                                      │
                                      ▼
                               AUDIT_COMPLETE (transient)
                              ┌───────┼───────┐
                              ▼       ▼       ▼
                           PASSED  WARNING  FAILED
                              │       │       │
                              │       ▼       ├──► CORRECTIONS_IN_PROGRESS
                              │  OFFICER_     │         │
                              │  REVIEW       │         ▼
                              │   │    │      │    DOCUMENTS_UPLOADED
                              │   ▼    ▼      │    (re-audit cycle)
                              │ PASSED FAILED │
                              │               ├──► OVERRIDE_PENDING
                              │               │         │
                              │               │         ▼
                              │               │    OVERRIDE_APPROVED
                              │               │         │
                              ▼               ▼         ▼
                     (v2) READY_FOR_SUBMISSION ◄────────┘
                              │
                              ▼
                     (v2) SUBMITTED
```

### Transition Rules
- `AUDIT_COMPLETE` is **transient**: the system immediately transitions to PASSED/FAILED/WARNING based on rule results. It exists for audit trail logging only.
- `CORRECTIONS_IN_PROGRESS → DOCUMENTS_UPLOADED`: officer must upload at least one corrected document or confirm field corrections.
- `OVERRIDE_PENDING → OVERRIDE_APPROVED`: requires a DIFFERENT user with `admin` or `supervisor` role + step-up MFA + text reason (minimum 20 characters).
- Any invalid transition returns HTTP 422 with error code `INVALID_STATE_TRANSITION`.
- Every transition writes to `audit_trail` with: claim_id, user_id, from_state, to_state, timestamp, metadata_json.

---

## 9. COMPLETE DATABASE SCHEMA

All tables use UUID v7 primary keys (time-sortable). Timestamps are `timestamptz`. Text fields storing PHI are encrypted at the application layer using AES-256-GCM before storage.

### Migration 001: Tenants & Facilities

```sql
-- 001_tenants_facilities.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE facilities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    name                TEXT NOT NULL,
    sha_facility_code   TEXT NOT NULL,          -- e.g. "FID-22-101101-0"
    mfl_code            TEXT,                    -- Master Facility List code
    tier_level          TEXT NOT NULL,           -- LEVEL_2, LEVEL_3A, LEVEL_3B, LEVEL_4, LEVEL_5, LEVEL_6
    license_status      TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE, SUSPENDED, REVOKED
    county              TEXT NOT NULL,
    sub_county          TEXT,
    facility_type       TEXT NOT NULL DEFAULT 'HOSPITAL', -- HOSPITAL, HEALTH_CENTER, DISPENSARY, CLINIC
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, sha_facility_code)
);

CREATE INDEX idx_facilities_tenant ON facilities(tenant_id);
CREATE INDEX idx_facilities_sha_code ON facilities(sha_facility_code);
```

### Migration 002: Users & Auth

```sql
-- 002_users_auth.sql

CREATE TYPE user_role AS ENUM ('super_admin', 'admin', 'supervisor', 'claims_officer', 'auditor', 'viewer');

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    facility_id     UUID REFERENCES facilities(id),   -- NULL for tenant-level admins
    email           TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    password_hash   TEXT NOT NULL,                      -- bcrypt
    role            user_role NOT NULL DEFAULT 'claims_officer',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    failed_login_count  INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,                        -- NULL = not locked
    last_login_at   TIMESTAMPTZ,
    password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    must_change_password BOOLEAN NOT NULL DEFAULT true, -- Force on first login
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, email)
);

CREATE TABLE mfa_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type     TEXT NOT NULL CHECK (device_type IN ('TOTP', 'WEBAUTHN')),
    device_name     TEXT NOT NULL DEFAULT 'Default',
    secret_encrypted TEXT NOT NULL,                     -- AES-256-GCM encrypted TOTP secret or WebAuthn public key
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,               -- SHA-256 of the refresh token
    family_id       UUID NOT NULL,                      -- Token rotation family
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,                        -- NULL = active
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(tenant_id, email);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
```

### Migration 003: Claims

```sql
-- 003_claims.sql

CREATE TYPE claim_status AS ENUM (
    'DRAFT',
    'DOCUMENTS_UPLOADED',
    'PROCESSING',
    'AUDIT_COMPLETE',
    'PASSED',
    'FAILED',
    'WARNING',
    'OFFICER_REVIEW',
    'CORRECTIONS_IN_PROGRESS',
    'OVERRIDE_PENDING',
    'OVERRIDE_APPROVED',
    'READY_FOR_SUBMISSION',
    'SUBMITTED'
);

CREATE TYPE claim_type AS ENUM ('OUTPATIENT', 'INPATIENT', 'MATERNITY', 'DENTAL', 'OPTICAL', 'MENTAL_HEALTH', 'RENAL', 'SURGICAL', 'EMERGENCY');

CREATE TYPE visit_type AS ENUM ('OP', 'IP', 'DAYCASE', 'EMERGENCY');

CREATE TABLE claims (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    facility_id     UUID NOT NULL REFERENCES facilities(id),
    -- Patient identity (encrypted at app layer)
    patient_sha_id  TEXT,                               -- SHA CR number e.g. "CR0000000000001-1"
    patient_name_enc TEXT,                              -- AES-256-GCM encrypted
    patient_national_id_enc TEXT,                       -- AES-256-GCM encrypted
    -- Claim metadata
    hmis_ref        TEXT,                               -- Reference from hospital HMIS
    claim_type      claim_type NOT NULL,
    visit_type      visit_type NOT NULL DEFAULT 'OP',
    admission_date  DATE NOT NULL,
    discharge_date  DATE,                               -- NULL for outpatient
    primary_diagnosis_code TEXT,                         -- ICD-11 code
    -- SHA-specific fields
    sha_benefit_package TEXT,                            -- e.g. "SHIF", "ECCIF"
    preauth_number  TEXT,                               -- NULL if no preauth required
    -- State
    status          claim_status NOT NULL DEFAULT 'DRAFT',
    version         INTEGER NOT NULL DEFAULT 1,         -- Optimistic concurrency
    -- Audit context
    last_audit_session_id UUID,                         -- FK added after audit_sessions created
    -- Deduplication
    dedup_hash      TEXT,                               -- SHA-256(patient_sha_id + facility_id + admission_date + primary_diagnosis_code)
    -- Tracking
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE claim_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    line_number     INTEGER NOT NULL,
    sha_service_code TEXT NOT NULL,                     -- SHA tariff code
    description     TEXT NOT NULL,
    icd_code        TEXT,                               -- ICD-11 diagnosis code for this line
    procedure_code  TEXT,                               -- SHA procedure code
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      NUMERIC(12,2) NOT NULL,
    total_amount    NUMERIC(12,2) NOT NULL,
    preauth_number  TEXT,                               -- Line-level preauth if different
    status          TEXT NOT NULL DEFAULT 'PENDING',    -- PENDING, VALIDATED, REJECTED
    validation_notes TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(claim_id, line_number)
);

CREATE INDEX idx_claims_tenant ON claims(tenant_id);
CREATE INDEX idx_claims_facility ON claims(facility_id);
CREATE INDEX idx_claims_status ON claims(tenant_id, status);
CREATE INDEX idx_claims_patient ON claims(tenant_id, patient_sha_id);
CREATE INDEX idx_claims_dedup ON claims(dedup_hash);
CREATE INDEX idx_claims_created ON claims(tenant_id, created_at DESC);
CREATE INDEX idx_claim_lines_claim ON claim_lines(claim_id);
```

### Migration 004: Documents

```sql
-- 004_documents.sql

CREATE TYPE doc_type AS ENUM (
    'SHA_CLAIM_FORM_OP',        -- Outpatient claim form
    'SHA_CLAIM_FORM_IP',        -- Inpatient claim form
    'SHA_CLAIM_FORM_MATERNITY', -- Maternity claim form
    'PREAUTH_FORM',             -- Preauthorization form
    'DISCHARGE_SUMMARY',
    'PHYSICIAN_NOTES',
    'LAB_RESULTS',
    'PRESCRIPTION',
    'REFERRAL_LETTER',
    'RADIOLOGY_REPORT',
    'OPERATIVE_NOTE',
    'NATIONAL_ID_COPY',
    'SHA_CARD_COPY',
    'CONSENT_FORM',
    'OTHER_SUPPORTING'
);

CREATE TYPE doc_processing_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'MANUAL_ENTRY_REQUIRED');

CREATE TYPE doc_processing_route AS ENUM (
    'FULL_OCR_EXTRACT',         -- Claim forms, physician notes, prescriptions
    'EXISTENCE_QUALITY_ONLY',   -- National ID copy, SHA card copy
    'STRUCTURED_EXTRACT',       -- Lab results (tabular data)
    'SIGNATURE_DETECT_ONLY'     -- Consent forms
);

CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    doc_type        doc_type NOT NULL,
    processing_route doc_processing_route NOT NULL,
    mime_type       TEXT NOT NULL,                      -- application/pdf, image/jpeg, image/png
    original_filename TEXT NOT NULL,
    page_count      INTEGER NOT NULL DEFAULT 0,
    file_size_bytes BIGINT NOT NULL,
    storage_path    TEXT NOT NULL,                      -- Relative path within DocumentStore
    sha256          TEXT NOT NULL,                      -- File integrity hash
    processing_status doc_processing_status NOT NULL DEFAULT 'PENDING',
    processing_error TEXT,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_pages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    status          doc_processing_status NOT NULL DEFAULT 'PENDING',
    ocr_engine_used TEXT,                               -- 'tesseract', 'paddleocr', 'ensemble'
    overall_confidence REAL,                            -- 0.0–1.0 aggregate
    image_quality_score REAL,                           -- 0.0–1.0 (blur/skew/DPI)
    retry_count     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    processed_at    TIMESTAMPTZ,
    UNIQUE(document_id, page_number)
);

CREATE INDEX idx_documents_claim ON documents(claim_id);
CREATE INDEX idx_documents_type ON documents(doc_type);
CREATE INDEX idx_document_pages_doc ON document_pages(document_id);
```

### Migration 005: Extraction

```sql
-- 005_extraction.sql

CREATE TYPE field_confidence_tier AS ENUM ('HIGH', 'MEDIUM', 'LOW');

CREATE TABLE ocr_text (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    raw_text        TEXT NOT NULL,
    engine          TEXT NOT NULL,                      -- 'tesseract', 'paddleocr', 'ensemble'
    overall_confidence REAL NOT NULL,                   -- 0.0–1.0
    word_count      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(document_id, page_number, engine)
);

CREATE TABLE extracted_fields (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    field_key       TEXT NOT NULL,                      -- e.g. 'patient_name', 'diagnosis', 'physician_signature_present'
    field_value     TEXT,                               -- Extracted value (encrypted if PHI)
    confidence      REAL NOT NULL,                      -- 0.0–1.0
    confidence_tier field_confidence_tier NOT NULL,     -- Computed from thresholds
    bbox_json       JSONB,                             -- {"x": 10, "y": 20, "w": 200, "h": 30}
    source          TEXT NOT NULL DEFAULT 'OCR',        -- OCR, MANUAL, CLASSIFIER, HEURISTIC
    needs_review    BOOLEAN NOT NULL DEFAULT false,
    reviewed        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE corrections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    extracted_field_id  UUID NOT NULL REFERENCES extracted_fields(id) ON DELETE CASCADE,
    original_value      TEXT,
    corrected_value     TEXT NOT NULL,
    corrected_by        UUID NOT NULL REFERENCES users(id),
    corrected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_for_training   BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_ocr_text_doc ON ocr_text(document_id);
CREATE INDEX idx_extracted_fields_claim ON extracted_fields(claim_id);
CREATE INDEX idx_extracted_fields_review ON extracted_fields(claim_id, needs_review, reviewed);
CREATE INDEX idx_corrections_field ON corrections(extracted_field_id);
CREATE INDEX idx_corrections_training ON corrections(used_for_training) WHERE used_for_training = false;
```

### Migration 006: Rulepacks

```sql
-- 006_rulepacks.sql

CREATE TYPE rule_severity AS ENUM ('HARD_STOP', 'MAJOR', 'MINOR', 'INFO');
CREATE TYPE rule_category AS ENUM ('IDENTITY', 'DOCUMENTATION', 'CLINICAL', 'AUTHORIZATION', 'FINANCIAL', 'STRUCTURAL');

CREATE TABLE rulepacks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_semver  TEXT NOT NULL UNIQUE,               -- e.g. "1.0.0"
    version_major   INTEGER NOT NULL,
    version_minor   INTEGER NOT NULL,
    version_patch   INTEGER NOT NULL,
    sha_policy_version TEXT,                            -- SHA policy this aligns with
    description     TEXT,
    rule_count      INTEGER NOT NULL DEFAULT 0,
    checksum        TEXT NOT NULL,                      -- SHA-256 of rulepack YAML content
    is_activated    BOOLEAN NOT NULL DEFAULT false,
    activated_at    TIMESTAMPTZ,
    activated_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rulepack_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rulepack_id     UUID NOT NULL REFERENCES rulepacks(id) ON DELETE CASCADE,
    rule_id         TEXT NOT NULL,                      -- e.g. "IDN-001"
    category        rule_category NOT NULL,
    severity        rule_severity NOT NULL,
    logic_key       TEXT NOT NULL,                      -- Function name in rule-engine
    params_json     JSONB NOT NULL DEFAULT '{}',        -- Rule-specific parameters
    applies_to      JSONB NOT NULL DEFAULT '["ALL"]',   -- Claim types this rule applies to: ["OUTPATIENT","INPATIENT"] or ["ALL"]
    message_i18n    JSONB NOT NULL,                     -- {"en": "...", "sw": "..."}
    remediation_i18n JSONB NOT NULL,                    -- {"en": "...", "sw": "..."}
    is_active       BOOLEAN NOT NULL DEFAULT true,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(rulepack_id, rule_id)
);

-- Keep last 3 activated versions
CREATE INDEX idx_rulepacks_active ON rulepacks(is_activated, version_major DESC, version_minor DESC, version_patch DESC);
CREATE INDEX idx_rulepack_rules_pack ON rulepack_rules(rulepack_id);
CREATE INDEX idx_rulepack_rules_category ON rulepack_rules(rulepack_id, category, sort_order);
```

### Migration 007: Audits

```sql
-- 007_audits.sql

CREATE TYPE audit_decision AS ENUM ('PASSED', 'FAILED', 'WARNING');
CREATE TYPE rule_result_status AS ENUM ('PASS', 'FAIL', 'WARNING', 'INCOMPLETE', 'SKIPPED');

CREATE TABLE audit_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            UUID NOT NULL REFERENCES claims(id),
    user_id             UUID NOT NULL REFERENCES users(id),     -- Who triggered the audit
    rulepack_version    TEXT NOT NULL,
    rulepack_checksum   TEXT NOT NULL,
    decision            audit_decision,                          -- NULL while processing
    total_rules         INTEGER NOT NULL DEFAULT 0,
    passed_count        INTEGER NOT NULL DEFAULT 0,
    failed_count        INTEGER NOT NULL DEFAULT 0,
    warning_count       INTEGER NOT NULL DEFAULT 0,
    incomplete_count    INTEGER NOT NULL DEFAULT 0,
    skipped_count       INTEGER NOT NULL DEFAULT 0,
    deterministic_score REAL,                                    -- 0.0–1.0 (% rules passed)
    ml_quality_score    REAL,                                    -- Avg extraction confidence
    fix_report_md       TEXT,                                    -- Generated Markdown fix report
    fix_report_pdf_path TEXT,                                    -- Path to PDF version
    execution_time_ms   INTEGER,                                 -- Pipeline duration
    is_batch            BOOLEAN NOT NULL DEFAULT false,
    batch_job_id        UUID,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE TABLE rule_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_session_id UUID NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
    rule_id         TEXT NOT NULL,
    category        rule_category NOT NULL,
    severity        rule_severity NOT NULL,
    result          rule_result_status NOT NULL,
    message         TEXT NOT NULL,                     -- Resolved i18n message
    remediation     TEXT,                              -- Resolved i18n remediation
    evidence_json   JSONB,                            -- {"document_id": "...", "page": 3, "field": "patient_name", "expected": "...", "actual": "...", "bbox": {...}}
    execution_time_ms INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add FK from claims to audit_sessions
ALTER TABLE claims ADD CONSTRAINT fk_claims_last_audit
    FOREIGN KEY (last_audit_session_id) REFERENCES audit_sessions(id);

CREATE INDEX idx_audit_sessions_claim ON audit_sessions(claim_id);
CREATE INDEX idx_audit_sessions_decision ON audit_sessions(decision);
CREATE INDEX idx_rule_results_session ON rule_results(audit_session_id);
CREATE INDEX idx_rule_results_rule ON rule_results(rule_id, result);
```

### Migration 008: Audit Trail

```sql
-- 008_audit_trail.sql

CREATE TYPE audit_action AS ENUM (
    'CLAIM_CREATED',
    'CLAIM_UPDATED',
    'DOCUMENT_UPLOADED',
    'DOCUMENT_DELETED',
    'AUDIT_STARTED',
    'AUDIT_COMPLETED',
    'FIELD_CORRECTED',
    'OVERRIDE_REQUESTED',
    'OVERRIDE_APPROVED',
    'OVERRIDE_REJECTED',
    'CLAIM_STATE_CHANGED',
    'CLAIM_EXPORTED',
    'BATCH_AUDIT_STARTED',
    'BATCH_AUDIT_COMPLETED',
    'USER_LOGIN',
    'USER_LOGOUT',
    'USER_MFA_VERIFIED',
    'USER_LOCKED',
    'RULEPACK_ACTIVATED',
    'RULEPACK_ROLLED_BACK',
    'SYSTEM_DEGRADED_MODE_ENTERED',
    'SYSTEM_DEGRADED_MODE_EXITED'
);

CREATE TABLE audit_trail (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    claim_id        UUID,                               -- NULL for non-claim events
    user_id         UUID REFERENCES users(id),          -- NULL for system events
    action          audit_action NOT NULL,
    from_state      claim_status,                       -- For state transitions
    to_state        claim_status,                       -- For state transitions
    detail_json     JSONB NOT NULL DEFAULT '{}',        -- Action-specific metadata
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only: no UPDATE or DELETE triggers
CREATE OR REPLACE FUNCTION prevent_audit_trail_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_trail is append-only. UPDATE and DELETE are prohibited.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER no_update_audit_trail
    BEFORE UPDATE OR DELETE ON audit_trail
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_trail_modification();

-- Partition by month for performance and archival
-- (Implemented via Postgres native partitioning — Claude Code should create
--  initial partitions for the next 12 months and a cron job to create future ones)

CREATE INDEX idx_audit_trail_tenant ON audit_trail(tenant_id, created_at DESC);
CREATE INDEX idx_audit_trail_claim ON audit_trail(claim_id, created_at DESC) WHERE claim_id IS NOT NULL;
CREATE INDEX idx_audit_trail_user ON audit_trail(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_audit_trail_action ON audit_trail(action, created_at DESC);
```

### Migration 009: Tariffs

```sql
-- 009_tariffs.sql

CREATE TABLE tariff_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version         TEXT NOT NULL UNIQUE,
    description     TEXT,
    source_url      TEXT,                               -- URL to official SHA tariff document
    published_date  DATE NOT NULL,
    checksum        TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT false,
    activated_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tariffs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tariff_version_id UUID NOT NULL REFERENCES tariff_versions(id) ON DELETE CASCADE,
    sha_service_code TEXT NOT NULL,
    description     TEXT NOT NULL,
    benefit_package TEXT NOT NULL,                      -- SHIF, ECCIF, etc.
    facility_tier   TEXT,                               -- LEVEL_2, LEVEL_3A, etc. (NULL = all tiers)
    claim_type      claim_type,                         -- NULL = applies to all claim types
    max_amount_kes  NUMERIC(12,2) NOT NULL,
    requires_preauth BOOLEAN NOT NULL DEFAULT false,
    effective_from  DATE NOT NULL,
    effective_to    DATE,                               -- NULL = currently active
    UNIQUE(tariff_version_id, sha_service_code, benefit_package, facility_tier)
);

CREATE INDEX idx_tariffs_version ON tariffs(tariff_version_id);
CREATE INDEX idx_tariffs_code ON tariffs(sha_service_code, benefit_package);
CREATE INDEX idx_tariffs_active ON tariffs(tariff_version_id, effective_from, effective_to);
```

### Migration 010: Jobs & Outbox

```sql
-- 010_jobs_outbox.sql

-- pg-boss creates its own tables, but we define the outbox pattern

CREATE TABLE outbox_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type  TEXT NOT NULL,                      -- 'claim', 'audit', 'sync'
    aggregate_id    UUID NOT NULL,
    event_type      TEXT NOT NULL,                      -- 'claim.created', 'audit.completed', etc.
    payload_json    JSONB NOT NULL,
    published       BOOLEAN NOT NULL DEFAULT false,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
    idempotency_key TEXT PRIMARY KEY,
    response_status INTEGER NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours')
);

CREATE INDEX idx_outbox_unpublished ON outbox_events(published, created_at) WHERE published = false;
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);
```

### Migration 011: Sync

```sql
-- 011_sync.sql

CREATE TYPE sync_direction AS ENUM ('UP', 'DOWN');
CREATE TYPE sync_payload_type AS ENUM ('METRICS', 'RULEPACK', 'MODEL', 'SOFTWARE', 'LICENSE');
CREATE TYPE sync_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

CREATE TABLE sync_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction       sync_direction NOT NULL,
    payload_type    sync_payload_type NOT NULL,
    status          sync_status NOT NULL DEFAULT 'PENDING',
    payload_ref     TEXT,                               -- URL or file path
    payload_checksum TEXT,
    error_message   TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    attempted_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE license_state (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     UUID NOT NULL REFERENCES facilities(id),
    tier            TEXT NOT NULL DEFAULT 'FREE',       -- FREE, PRO
    license_token   TEXT NOT NULL,
    feature_flags   JSONB NOT NULL DEFAULT '{}',
    expires_at      TIMESTAMPTZ NOT NULL,
    last_validated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    offline_grace_until TIMESTAMPTZ,                    -- expires_at + 30 days
    UNIQUE(facility_id)
);
```

### Migration 012: ICD Codes (Reference Data)

```sql
-- 012_icd_codes.sql

CREATE TABLE icd_codes (
    code            TEXT PRIMARY KEY,                   -- e.g. "1A00", "BA00"
    version         TEXT NOT NULL DEFAULT '11',         -- ICD-11
    title_en        TEXT NOT NULL,
    title_sw        TEXT,
    chapter         TEXT,
    block           TEXT,
    is_leaf         BOOLEAN NOT NULL DEFAULT true,      -- Can be used for coding
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sha_service_codes (
    code            TEXT PRIMARY KEY,
    description     TEXT NOT NULL,
    category        TEXT,                               -- Consultation, Procedure, Lab, Pharmacy, etc.
    benefit_packages JSONB NOT NULL DEFAULT '["SHIF"]', -- Which packages this code belongs to
    requires_preauth BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_icd_codes_chapter ON icd_codes(chapter);
CREATE INDEX idx_sha_codes_category ON sha_service_codes(category);
```

### Migration 013: Registry Cache

```sql
-- 013_registry_cache.sql

CREATE TABLE registry_cache (
    cache_key       TEXT PRIMARY KEY,                   -- e.g. "patient:CR0000000000001-1"
    registry_type   TEXT NOT NULL,                      -- 'CLIENT', 'FACILITY', 'HEALTH_WORKER'
    response_json   JSONB NOT NULL,
    is_valid        BOOLEAN NOT NULL DEFAULT true,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,               -- fetched_at + 24h TTL
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_registry_cache_expires ON registry_cache(expires_at);
CREATE INDEX idx_registry_cache_type ON registry_cache(registry_type);
```

### Migration 014: Performance Indexes

```sql
-- 014_indexes.sql

-- Composite indexes for common dashboard queries
CREATE INDEX idx_claims_dashboard ON claims(tenant_id, facility_id, status, created_at DESC);

-- Rule results aggregation
CREATE INDEX idx_rule_results_failures ON rule_results(rule_id, result) WHERE result = 'FAIL';

-- Audit sessions date range
CREATE INDEX idx_audit_sessions_date ON audit_sessions(started_at DESC);

-- Corrections pending training
CREATE INDEX idx_corrections_pending ON corrections(used_for_training) WHERE used_for_training = false;

-- Cleanup: expired idempotency keys (run daily via pg-boss scheduled job)
-- DELETE FROM idempotency_keys WHERE expires_at < now();

-- Cleanup: expired registry cache (run hourly)
-- DELETE FROM registry_cache WHERE expires_at < now();
```

---

## 10. FULL API CONTRACTS

### Response Envelope

Every API response follows this structure:

```typescript
// Success response
interface ApiResponse<T> {
  data: T;
  meta?: {
    cursor?: string;          // For pagination
    hasMore?: boolean;
    total?: number;           // Only when countable
    requestId: string;        // For debugging/support
  };
}

// Error response
interface ApiError {
  errors: Array<{
    code: string;             // Machine-readable: e.g. "VALIDATION_ERROR"
    message: string;          // Human-readable
    field?: string;           // Which field caused the error
    detail?: Record<string, unknown>;
  }>;
  meta: {
    requestId: string;
  };
}
```

### Error Code Taxonomy

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `VALIDATION_ERROR` | 400 | Request body/params failed validation |
| `INVALID_DOCUMENT_TYPE` | 400 | Uploaded document type not in enum |
| `FILE_TOO_LARGE` | 413 | Upload exceeds size limit |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT |
| `MFA_REQUIRED` | 401 | Step-up auth needed for this action |
| `FORBIDDEN` | 403 | User lacks required role/permission |
| `NOT_FOUND` | 404 | Resource doesn't exist or not in tenant |
| `CONCURRENCY_CONFLICT` | 409 | Version mismatch on update |
| `DUPLICATE_CLAIM` | 409 | Deduplication hash matches existing claim |
| `INVALID_STATE_TRANSITION` | 422 | Claim cannot transition to requested state |
| `RULE_HARD_STOP` | 422 | Audit blocked by hard-stop rule failure |
| `RATE_LIMITED` | 429 | Too many requests |
| `EXTERNAL_DEPENDENCY_DEGRADED` | 503 | Registry/external service unavailable |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### Endpoint Specifications

#### 10.1 Claims

**POST /v1/claims** — Create a new claim

```typescript
// Headers
// Authorization: Bearer <jwt>
// Idempotency-Key: <uuid>           (required — prevents duplicate creation)
// Content-Type: application/json

// Request Body
interface CreateClaimRequest {
  facilityId: string;                 // UUID
  claimType: 'OUTPATIENT' | 'INPATIENT' | 'MATERNITY' | 'DENTAL' | 'OPTICAL' | 'MENTAL_HEALTH' | 'RENAL' | 'SURGICAL' | 'EMERGENCY';
  visitType: 'OP' | 'IP' | 'DAYCASE' | 'EMERGENCY';
  patientShaId?: string;             // SHA CR number
  patientName?: string;              // Will be encrypted at rest
  patientNationalId?: string;        // Will be encrypted at rest
  hmisRef?: string;                  // Hospital HMIS reference
  admissionDate: string;             // ISO 8601 date: "2026-03-01"
  dischargeDate?: string;            // ISO 8601 date (required for inpatient)
  primaryDiagnosisCode?: string;     // ICD-11 code
  shaBenefitPackage?: string;        // "SHIF" | "ECCIF"
  preauthNumber?: string;
  lines?: Array<{
    shaServiceCode: string;
    description: string;
    icdCode?: string;
    procedureCode?: string;
    quantity: number;                 // >= 1
    unitPrice: number;               // >= 0, KES
  }>;
}

// Response: 201 Created
interface CreateClaimResponse {
  data: {
    id: string;
    status: 'DRAFT';
    version: 1;
    facilityId: string;
    claimType: string;
    visitType: string;
    admissionDate: string;
    dischargeDate: string | null;
    primaryDiagnosisCode: string | null;
    lineCount: number;
    createdBy: string;
    createdAt: string;                // ISO 8601
  };
  meta: { requestId: string };
}
```

**GET /v1/claims** — List claims with cursor pagination

```typescript
// Query parameters
interface ListClaimsQuery {
  cursor?: string;                    // Opaque cursor from previous response
  limit?: number;                     // 1–100, default 25
  status?: string;                    // Comma-separated: "DRAFT,FAILED"
  claimType?: string;                 // Single value filter
  facilityId?: string;               // UUID
  dateFrom?: string;                  // ISO 8601 date
  dateTo?: string;                    // ISO 8601 date
  q?: string;                        // Free text search (HMIS ref, patient SHA ID)
  sortBy?: 'createdAt' | 'updatedAt' | 'admissionDate';  // Default: createdAt
  sortOrder?: 'asc' | 'desc';        // Default: desc
}

// Response: 200 OK
interface ListClaimsResponse {
  data: Array<{
    id: string;
    status: string;
    version: number;
    claimType: string;
    visitType: string;
    hmisRef: string | null;
    patientShaId: string | null;
    admissionDate: string;
    primaryDiagnosisCode: string | null;
    documentCount: number;
    lineCount: number;
    lastAuditDecision: string | null;  // PASSED, FAILED, WARNING, null
    totalAmount: number;               // Sum of claim lines
    createdAt: string;
    updatedAt: string;
  }>;
  meta: {
    cursor: string | null;            // null if no more results
    hasMore: boolean;
    total: number;
    requestId: string;
  };
}
```

**GET /v1/claims/:claimId** — Get claim detail

```typescript
// Response: 200 OK
interface GetClaimResponse {
  data: {
    id: string;
    status: string;
    version: number;
    facilityId: string;
    facilityName: string;
    claimType: string;
    visitType: string;
    patientShaId: string | null;
    patientName: string | null;        // Decrypted for authorized users
    hmisRef: string | null;
    admissionDate: string;
    dischargeDate: string | null;
    primaryDiagnosisCode: string | null;
    primaryDiagnosisDisplay: string | null;  // ICD-11 title
    shaBenefitPackage: string | null;
    preauthNumber: string | null;
    lines: Array<{
      id: string;
      lineNumber: number;
      shaServiceCode: string;
      description: string;
      icdCode: string | null;
      procedureCode: string | null;
      quantity: number;
      unitPrice: number;
      totalAmount: number;
      status: string;
      validationNotes: string | null;
    }>;
    documents: Array<{
      id: string;
      docType: string;
      originalFilename: string;
      pageCount: number;
      processingStatus: string;
      uploadedAt: string;
    }>;
    lastAudit: {
      id: string;
      decision: string;
      rulesExecuted: number;
      failedCount: number;
      warningCount: number;
      executionTimeMs: number;
      completedAt: string;
    } | null;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  };
  meta: { requestId: string };
}
```

**PATCH /v1/claims/:claimId** — Update claim fields

```typescript
// Headers
// If-Match: <version>               (required for optimistic concurrency)

// Request Body (all fields optional)
interface UpdateClaimRequest {
  patientShaId?: string;
  patientName?: string;
  patientNationalId?: string;
  hmisRef?: string;
  admissionDate?: string;
  dischargeDate?: string;
  primaryDiagnosisCode?: string;
  shaBenefitPackage?: string;
  preauthNumber?: string;
  lines?: Array<{                     // Full replacement of lines
    shaServiceCode: string;
    description: string;
    icdCode?: string;
    procedureCode?: string;
    quantity: number;
    unitPrice: number;
  }>;
}

// Response: 200 OK (same shape as GetClaimResponse)
// Error: 409 if version mismatch
```

#### 10.2 Documents

**POST /v1/claims/:claimId/documents** — Upload document

```typescript
// Content-Type: multipart/form-data
// Fields:
//   file: <binary>                   (required, max 50MB)
//   docType: <doc_type enum>         (required)

// Response: 201 Created
interface UploadDocumentResponse {
  data: {
    id: string;
    claimId: string;
    docType: string;
    processingRoute: string;
    originalFilename: string;
    mimeType: string;
    pageCount: number;
    fileSizeBytes: number;
    sha256: string;
    processingStatus: 'PENDING';
    uploadedAt: string;
  };
  meta: { requestId: string };
}
```

**GET /v1/claims/:claimId/documents** — List claim documents

**GET /v1/documents/:docId/download** — Download document file (streams binary, requires auth + writes to audit_trail)

**GET /v1/documents/:docId/pages/:pageNumber/extraction** — Get extraction results for a page

```typescript
interface PageExtractionResponse {
  data: {
    documentId: string;
    pageNumber: number;
    ocrText: string;
    ocrConfidence: number;
    imageQualityScore: number;
    fields: Array<{
      id: string;
      fieldKey: string;
      fieldValue: string | null;
      confidence: number;
      confidenceTier: 'HIGH' | 'MEDIUM' | 'LOW';
      bbox: { x: number; y: number; w: number; h: number } | null;
      source: string;
      needsReview: boolean;
      reviewed: boolean;
    }>;
  };
  meta: { requestId: string };
}
```

**POST /v1/extracted-fields/:fieldId/correct** — Submit field correction

```typescript
interface CorrectFieldRequest {
  correctedValue: string;             // New value
}

// Response: 200 OK
interface CorrectFieldResponse {
  data: {
    fieldId: string;
    originalValue: string | null;
    correctedValue: string;
    correctedBy: string;
    correctedAt: string;
  };
  meta: { requestId: string };
}
```

#### 10.3 Audit

**POST /v1/claims/:claimId/audit** — Trigger audit

```typescript
// Request: empty body (or optional)
interface TriggerAuditRequest {
  forceReprocess?: boolean;           // Re-run OCR even if already processed
}

// Response: 202 Accepted (if queued) or 200 OK (if inline)
interface TriggerAuditResponse {
  data: {
    auditSessionId: string;
    claimId: string;
    status: 'PROCESSING' | 'COMPLETED';
    rulesExecuted?: number;
    decision?: string;                // Only if inline completion
  };
  meta: { requestId: string };
}
```

**GET /v1/claims/:claimId/audit/latest** — Get latest audit result

```typescript
interface AuditResultResponse {
  data: {
    id: string;
    claimId: string;
    decision: 'PASSED' | 'FAILED' | 'WARNING';
    rupackVersion: string;
    totalRules: number;
    passedCount: number;
    failedCount: number;
    warningCount: number;
    incompleteCount: number;
    deterministicScore: number;
    mlQualityScore: number;
    executionTimeMs: number;
    fixReportMarkdown: string;
    ruleResults: Array<{
      ruleId: string;
      category: string;
      severity: string;
      result: 'PASS' | 'FAIL' | 'WARNING' | 'INCOMPLETE' | 'SKIPPED';
      message: string;
      remediation: string | null;
      evidence: {
        documentId?: string;
        page?: number;
        field?: string;
        expected?: string;
        actual?: string;
        bbox?: { x: number; y: number; w: number; h: number };
      } | null;
    }>;
    startedAt: string;
    completedAt: string;
  };
  meta: { requestId: string };
}
```

**POST /v1/claims/:claimId/override** — Request audit override

```typescript
interface OverrideRequest {
  reason: string;                     // Minimum 20 characters
}

// Response: 200 OK — claim moves to OVERRIDE_PENDING
// Requires step-up MFA
```

**POST /v1/claims/:claimId/override/approve** — Approve override (supervisor only)

```typescript
interface ApproveOverrideRequest {
  supervisorNotes?: string;
}

// Response: 200 OK — claim moves to OVERRIDE_APPROVED
// Requires different user than requester + step-up MFA
```

#### 10.4 Batch Audit

**POST /v1/claims/batch-audit** — Start batch audit

```typescript
interface BatchAuditRequest {
  claimIds?: string[];                // Specific claims (max 200)
  filter?: {                          // Or audit all matching filter
    status: 'DOCUMENTS_UPLOADED';     // Only this status allowed for batch
    facilityId?: string;
    dateFrom?: string;
    dateTo?: string;
  };
  concurrency?: number;               // 1–8, default 4
}

// Response: 202 Accepted
interface BatchAuditResponse {
  data: {
    jobId: string;
    totalClaims: number;
    status: 'QUEUED';
    createdAt: string;
  };
  meta: { requestId: string };
}
```

**GET /v1/jobs/:jobId** — Get batch job status

```typescript
interface JobStatusResponse {
  data: {
    jobId: string;
    type: 'BATCH_AUDIT';
    status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    totalClaims: number;
    processedClaims: number;
    passedCount: number;
    failedCount: number;
    warningCount: number;
    errorCount: number;
    errors: Array<{
      claimId: string;
      error: string;
    }>;
    startedAt: string | null;
    completedAt: string | null;
  };
  meta: { requestId: string };
}
```

#### 10.5 Dashboard

**GET /v1/dashboard/overview** — Facility overview

```typescript
interface DashboardOverviewResponse {
  data: {
    period: { from: string; to: string }; // Current month default
    claims: {
      total: number;
      byStatus: Record<string, number>; // { DRAFT: 5, PASSED: 42, FAILED: 8, ... }
      createdToday: number;
      createdThisWeek: number;
    };
    audit: {
      passRate: number;                  // 0.0–1.0
      avgAuditTimeMs: number;
      auditsToday: number;
      auditsThisWeek: number;
    };
    documents: {
      totalUploaded: number;
      avgOcrConfidence: number;          // 0.0–1.0
      manualEntryRequired: number;       // Docs flagged for manual entry
    };
    queue: {
      pendingJobs: number;
      avgWaitTimeMs: number;
    };
    systemHealth: {
      mlServiceStatus: 'UP' | 'DOWN' | 'DEGRADED';
      dbConnectionPool: { active: number; idle: number; max: number };
      diskUsagePercent: number;
    };
  };
  meta: { requestId: string };
}
```

**GET /v1/dashboard/rules/top-failures** — Top failing rules

```typescript
// Query: ?period=7d|30d|90d&limit=20

interface TopFailuresResponse {
  data: Array<{
    ruleId: string;
    category: string;
    severity: string;
    message: string;
    failureCount: number;
    affectedClaimsCount: number;
    trend: 'UP' | 'DOWN' | 'STABLE';   // Compared to previous period
    trendPercent: number;               // e.g. +15.2 or -8.1
    exampleClaimIds: string[];          // Up to 3 recent examples
  }>;
  meta: { requestId: string };
}
```

**GET /v1/dashboard/officer-productivity** — Officer performance

```typescript
interface OfficerProductivityResponse {
  data: Array<{
    userId: string;
    displayName: string;
    claimsAuditedToday: number;
    claimsAuditedThisWeek: number;
    avgAuditTimeMinutes: number;
    correctionsCount: number;
    overridesRequested: number;
  }>;
  meta: { requestId: string };
}
```

**GET /v1/dashboard/document-quality** — Document quality by type

```typescript
interface DocumentQualityResponse {
  data: Array<{
    docType: string;
    totalProcessed: number;
    avgOcrConfidence: number;
    manualEntryRate: number;            // 0.0–1.0
    avgFieldsPerDoc: number;
    avgCorrectionsPerDoc: number;
  }>;
  meta: { requestId: string };
}
```

#### 10.6 Auth

**POST /v1/auth/login** — Authenticate

```typescript
interface LoginRequest {
  email: string;
  password: string;
}

// Response: 200 OK
interface LoginResponse {
  data: {
    requiresMfa: boolean;
    mfaToken?: string;                 // Temporary token for MFA step
    accessToken?: string;              // Only if MFA not required (shouldn't happen in prod)
    refreshToken?: string;
  };
  meta: { requestId: string };
}
```

**POST /v1/auth/mfa/verify** — Verify TOTP code

```typescript
interface MfaVerifyRequest {
  mfaToken: string;                   // From login response
  code: string;                       // 6-digit TOTP
}

// Response: 200 OK
interface MfaVerifyResponse {
  data: {
    accessToken: string;               // JWT RS256, 15min expiry
    refreshToken: string;              // Opaque, 7-day expiry
    user: {
      id: string;
      email: string;
      displayName: string;
      role: string;
      facilityId: string | null;
      tenantId: string;
    };
  };
  meta: { requestId: string };
}
```

**POST /v1/auth/refresh** — Refresh access token

**POST /v1/auth/logout** — Revoke refresh token family

**POST /v1/auth/mfa/setup** — Initialize TOTP setup (returns QR code URI)

**POST /v1/auth/password/change** — Change password (requires current password)

#### 10.7 Admin

**GET /v1/admin/rulepacks** — List rulepacks

**POST /v1/admin/rulepacks/:version/activate** — Activate a rulepack

**POST /v1/admin/rulepacks/:version/rollback** — Rollback to previous version

**GET /v1/admin/users** — List facility users

**POST /v1/admin/users** — Create user

**PATCH /v1/admin/users/:userId** — Update user (role, active status)

**POST /v1/admin/users/:userId/reset-password** — Admin password reset

#### 10.8 Export

**POST /v1/claims/:claimId/export** — Generate evidence pack

```typescript
// Requires step-up MFA

// Response: 202 Accepted
interface ExportResponse {
  data: {
    jobId: string;
    claimId: string;
    status: 'GENERATING';
  };
  meta: { requestId: string };
}

// Evidence pack contains:
// - audit_report.pdf (fix report as PDF)
// - audit_result.json (machine-readable)
// - documents/ (all uploaded documents)
// - file_hashes.json (SHA-256 of every file for integrity)
// - metadata.json (claim data, timestamps, rulepack version)
```

**GET /v1/exports/:jobId/download** — Download evidence pack ZIP

#### 10.9 Health

**GET /health** — Liveness check (no auth)

```typescript
// Response: 200 OK
{ "status": "ok", "timestamp": "2026-03-05T10:30:00Z" }
```

**GET /health/ready** — Readiness check (no auth)

```typescript
// Response: 200 OK or 503
{
  "status": "ready" | "degraded" | "unavailable",
  "checks": {
    "database": "ok" | "error",
    "mlService": "ok" | "error" | "degraded",
    "diskSpace": "ok" | "warning" | "critical",
    "jobQueue": "ok" | "error"
  }
}
```

**GET /metrics** — Prometheus-compatible metrics (no auth, internal network only)

```
# Key metrics exposed:
claimflow_claims_total{status="PASSED"} 1234
claimflow_claims_total{status="FAILED"} 56
claimflow_audit_duration_seconds_bucket{le="2.0"} 890
claimflow_audit_duration_seconds_bucket{le="5.0"} 1200
claimflow_ocr_confidence_avg 0.82
claimflow_job_queue_depth 3
claimflow_ml_service_errors_total 12
claimflow_rule_failures_total{rule_id="IDN-001"} 89
```

## 11. DETERMINISTIC RULE ENGINE

### Architecture

The rule engine is a pure function: given a claim snapshot (claim data + extracted fields + facility context) and a rulepack version, it produces identical output every time.

```typescript
// Core interface
interface RuleEngineInput {
  claim: ClaimSnapshot;
  extractedFields: Map<string, ExtractedField>;
  documents: DocumentSummary[];
  facilityContext: FacilityContext;
  tariffs: TariffLookup;
  registryResults: RegistryLookupResults;
}

interface RuleEngineOutput {
  decision: 'PASSED' | 'FAILED' | 'WARNING';
  totalRules: number;
  results: RuleResult[];
  fixReportMarkdown: string;
  executionTimeMs: number;
}

interface RuleResult {
  ruleId: string;
  category: RuleCategory;
  severity: RuleSeverity;
  result: 'PASS' | 'FAIL' | 'WARNING' | 'INCOMPLETE' | 'SKIPPED';
  message: string;              // i18n resolved
  remediation: string | null;   // i18n resolved
  evidence: RuleEvidence | null;
}
```

### Execution Model

1. Load active rulepack from database (cached in memory with version check).
2. Filter rules by `applies_to` vs. claim's `claim_type`.
3. Execute rules **in category order**: IDENTITY → DOCUMENTATION → CLINICAL → AUTHORIZATION → FINANCIAL → STRUCTURAL.
4. Within each category, execute all rules (parallel within category is safe since rules are independent).
5. **Evaluate ALL rules** even if HARD_STOP encountered — this ensures the fix report is complete.
6. Determine decision by **worst severity present**: any FAIL from HARD_STOP → FAILED; any WARNING → WARNING; else → PASSED.
7. Generate fix report markdown.
8. Return complete results.

### Rule YAML Format

```yaml
# Example: identity rule
rule_id: "IDN-001"
category: IDENTITY
severity: HARD_STOP
logic_key: "verify_patient_sha_id_exists"
applies_to: ["ALL"]
params:
  allow_cached: true
  cache_ttl_hours: 24
message_i18n:
  en: "Patient SHA ID not found in Client Registry"
  sw: "Nambari ya SHA ya mgonjwa haijapatikana kwenye Sajili ya Wateja"
remediation_i18n:
  en: "Verify the patient's SHA number. Check if the patient is registered at sha.go.ke or contact SHA support."
  sw: "Thibitisha nambari ya SHA ya mgonjwa. Angalia ikiwa mgonjwa amesajiliwa kwenye sha.go.ke au wasiliana na msaada wa SHA."
```

### Logic Key Registry

Each `logic_key` maps to a TypeScript function in the rule-engine package:

```typescript
// packages/rule-engine/src/rules/identity.ts

export const ruleLogicRegistry: Record<string, RuleLogicFn> = {
  verify_patient_sha_id_exists: (input, params) => {
    const shaId = input.claim.patientShaId;
    if (!shaId) return { result: 'FAIL', evidence: { field: 'patient_sha_id', expected: 'non-empty', actual: 'missing' } };
    const registryResult = input.registryResults.patient;
    if (!registryResult) return { result: 'INCOMPLETE', evidence: { reason: 'registry_unavailable' } };
    if (!registryResult.found) return { result: 'FAIL', evidence: { field: 'patient_sha_id', actual: shaId } };
    return { result: 'PASS' };
  },
  // ... more rules
};
```

### Fix Report Template

```markdown
# Claim Audit Report
**Claim ID:** {{claimId}}
**Facility:** {{facilityName}}
**Date:** {{auditDate}}
**Rulepack:** v{{rupackVersion}}
**Decision:** {{decision}}

## Summary
- Rules Executed: {{totalRules}}
- Passed: {{passedCount}} | Failed: {{failedCount}} | Warnings: {{warningCount}}

## Critical Issues (Must Fix)
{{#each hardStopFailures}}
### ❌ {{ruleId}}: {{message}}
**Category:** {{category}}
**How to fix:** {{remediation}}
{{#if evidence}}
**Evidence:** Document {{evidence.documentId}}, Page {{evidence.page}}, Field: {{evidence.field}}
{{/if}}
{{/each}}

## Warnings (Should Fix)
{{#each warnings}}
### ⚠️ {{ruleId}}: {{message}}
**How to fix:** {{remediation}}
{{/each}}

## Passed Rules
{{#each passed}}
- ✅ {{ruleId}}: {{message}}
{{/each}}
```

---

## 12. RULE CATALOG (120 Rules)

### IDENTITY (15 rules)

| Rule ID | Severity | Logic Key | Description (EN) |
|---------|----------|-----------|-------------------|
| IDN-001 | HARD_STOP | verify_patient_sha_id_exists | Patient SHA ID must exist in Client Registry |
| IDN-002 | HARD_STOP | verify_patient_sha_id_format | Patient SHA ID must match format CRxxxxxxxxx-x |
| IDN-003 | HARD_STOP | verify_patient_eligibility_active | Patient must have active SHA coverage |
| IDN-004 | MAJOR | verify_patient_name_matches_registry | Patient name on documents must match Client Registry |
| IDN-005 | HARD_STOP | verify_national_id_present | National ID or birth certificate number required |
| IDN-006 | MAJOR | verify_patient_gender_consistent | Gender on claim must match across all documents |
| IDN-007 | MAJOR | verify_patient_dob_consistent | Date of birth must be consistent across documents |
| IDN-008 | HARD_STOP | verify_facility_sha_code_valid | Facility must be registered in Facility Registry |
| IDN-009 | HARD_STOP | verify_facility_tier_matches | Facility tier in claim must match Facility Registry |
| IDN-010 | HARD_STOP | verify_practitioner_registered | Treating practitioner must be in Health Worker Registry |
| IDN-011 | MAJOR | verify_practitioner_license_active | Practitioner license must not be expired or suspended |
| IDN-012 | MINOR | verify_practitioner_specialty_appropriate | Practitioner specialty should match claim type |
| IDN-013 | HARD_STOP | verify_sha_card_copy_present | SHA card copy or digital verification must be present |
| IDN-014 | MAJOR | verify_national_id_copy_legible | National ID copy must pass image quality check |
| IDN-015 | MINOR | verify_patient_contact_present | Patient phone number or address should be recorded |

### DOCUMENTATION (35 rules)

| Rule ID | Severity | Logic Key | Description (EN) |
|---------|----------|-----------|-------------------|
| DOC-001 | HARD_STOP | verify_claim_form_present | SHA claim form (OP/IP/Maternity) must be present |
| DOC-002 | HARD_STOP | verify_claim_form_type_matches | Claim form type must match claim type (OP form for OP claim) |
| DOC-003 | HARD_STOP | verify_physician_signature_present | Physician signature detected on claim form |
| DOC-004 | HARD_STOP | verify_physician_stamp_present | Physician stamp/seal detected on claim form |
| DOC-005 | MAJOR | verify_claim_form_date_present | Date on claim form must be present and legible |
| DOC-006 | MAJOR | verify_claim_form_date_matches_admission | Claim form date must match admission/visit date |
| DOC-007 | HARD_STOP | verify_discharge_summary_present_ip | Discharge summary required for inpatient claims |
| DOC-008 | MAJOR | verify_discharge_summary_signed | Discharge summary must be signed by physician |
| DOC-009 | HARD_STOP | verify_physician_notes_present | Clinical/physician notes required |
| DOC-010 | MAJOR | verify_diagnosis_documented_in_notes | Diagnosis must appear in physician notes |
| DOC-011 | MAJOR | verify_treatment_plan_documented | Treatment plan or procedures must be documented |
| DOC-012 | HARD_STOP | verify_lab_results_present_if_claimed | Lab results required if lab services claimed |
| DOC-013 | MAJOR | verify_lab_results_from_accredited | Lab results should be from accredited facility |
| DOC-014 | HARD_STOP | verify_prescription_present_if_pharmacy | Prescription required if pharmacy items claimed |
| DOC-015 | MAJOR | verify_prescription_signed | Prescription must be signed by authorized prescriber |
| DOC-016 | HARD_STOP | verify_referral_letter_if_referred | Referral letter required for referred patients |
| DOC-017 | MAJOR | verify_referral_letter_valid | Referral letter must be from recognized facility |
| DOC-018 | HARD_STOP | verify_consent_form_if_surgical | Surgical consent form required for surgical claims |
| DOC-019 | MAJOR | verify_consent_form_signed_by_patient | Consent form must have patient/guardian signature |
| DOC-020 | HARD_STOP | verify_preauth_form_if_required | Preauthorization form required for applicable services |
| DOC-021 | MAJOR | verify_operative_note_if_surgical | Operative note required for surgical claims |
| DOC-022 | MAJOR | verify_anesthesia_record_if_applicable | Anesthesia record required for GA procedures |
| DOC-023 | MINOR | verify_nursing_notes_present_ip | Nursing notes recommended for inpatient claims |
| DOC-024 | MAJOR | verify_radiology_report_if_claimed | Radiology report required if imaging claimed |
| DOC-025 | MINOR | verify_all_pages_legible | All document pages must pass quality threshold |
| DOC-026 | MAJOR | verify_no_critical_fields_missing | Mandatory fields on claim form must be filled |
| DOC-027 | MINOR | verify_document_dates_consistent | Dates across documents should be consistent |
| DOC-028 | MAJOR | verify_patient_name_on_all_docs | Patient name must appear on all clinical documents |
| DOC-029 | MINOR | verify_facility_header_on_clinical_docs | Clinical docs should have facility letterhead |
| DOC-030 | HARD_STOP | verify_maternity_delivery_record | Delivery record required for maternity claims |
| DOC-031 | MAJOR | verify_baby_birth_notification | Birth notification required for delivery claims |
| DOC-032 | MINOR | verify_anc_card_if_maternity | ANC card recommended for maternity claims |
| DOC-033 | MAJOR | verify_document_not_expired | Document dates must be within claim period |
| DOC-034 | MINOR | verify_no_duplicate_documents | Warn if identical documents uploaded twice |
| DOC-035 | INFO | verify_document_completeness_score | Overall documentation completeness percentage |

### CLINICAL (25 rules)

| Rule ID | Severity | Logic Key | Description (EN) |
|---------|----------|-----------|-------------------|
| CLN-001 | HARD_STOP | verify_icd_code_valid | Primary diagnosis ICD-11 code must be valid |
| CLN-002 | HARD_STOP | verify_icd_code_specificity | ICD-11 code must be at leaf level (most specific) |
| CLN-003 | MAJOR | verify_diagnosis_matches_claim_type | Diagnosis must be clinically consistent with claim type |
| CLN-004 | MAJOR | verify_procedure_matches_diagnosis | Procedures must be clinically appropriate for diagnosis |
| CLN-005 | HARD_STOP | verify_procedure_code_valid | Procedure codes must be valid SHA service codes |
| CLN-006 | MAJOR | verify_los_appropriate | Length of stay consistent with diagnosis (inpatient) |
| CLN-007 | MINOR | verify_medications_match_diagnosis | Prescribed medications should relate to diagnosis |
| CLN-008 | MAJOR | verify_lab_tests_relevant | Lab tests should be clinically relevant to diagnosis |
| CLN-009 | MINOR | verify_no_clinical_contradictions | No contradictory clinical findings in documentation |
| CLN-010 | MAJOR | verify_age_appropriate_diagnosis | Diagnosis must be plausible for patient age |
| CLN-011 | MAJOR | verify_gender_appropriate_diagnosis | Diagnosis must be plausible for patient gender |
| CLN-012 | MAJOR | verify_maternity_gestational_age | Gestational age must be documented for maternity |
| CLN-013 | MINOR | verify_vital_signs_documented | Vital signs should be documented |
| CLN-014 | MAJOR | verify_admission_criteria_met_ip | Inpatient admission criteria should be documented |
| CLN-015 | MINOR | verify_follow_up_plan_documented | Follow-up plan recommended for chronic conditions |
| CLN-016 | MAJOR | verify_emergency_triage_documented | Emergency triage assessment required for emergency claims |
| CLN-017 | MINOR | verify_allergy_documentation | Allergy status should be documented |
| CLN-018 | HARD_STOP | verify_dental_chart_if_dental | Dental chart required for dental claims |
| CLN-019 | HARD_STOP | verify_optical_prescription_if_optical | Optical prescription required for optical claims |
| CLN-020 | MAJOR | verify_mental_health_assessment | Mental health assessment for psychiatric claims |
| CLN-021 | HARD_STOP | verify_dialysis_records_if_renal | Dialysis records required for renal claims |
| CLN-022 | MINOR | verify_bmi_documented | BMI should be documented for relevant conditions |
| CLN-023 | MAJOR | verify_chronology_makes_sense | Treatment timeline must be chronologically logical |
| CLN-024 | MINOR | verify_secondary_diagnosis_documented | Secondary diagnoses should be documented if present |
| CLN-025 | INFO | verify_clinical_completeness_score | Overall clinical documentation quality score |

### AUTHORIZATION (15 rules)

| Rule ID | Severity | Logic Key | Description (EN) |
|---------|----------|-----------|-------------------|
| AUT-001 | HARD_STOP | verify_preauth_exists_if_required | Preauthorization must exist for services requiring it |
| AUT-002 | HARD_STOP | verify_preauth_number_valid | Preauthorization number must be valid (format check) |
| AUT-003 | HARD_STOP | verify_preauth_not_expired | Preauthorization must not be expired |
| AUT-004 | HARD_STOP | verify_preauth_covers_services | Preauthorized services must match claimed services |
| AUT-005 | MAJOR | verify_preauth_facility_matches | Preauth facility must match claim facility |
| AUT-006 | MAJOR | verify_preauth_patient_matches | Preauth patient must match claim patient |
| AUT-007 | HARD_STOP | verify_benefit_package_covers_service | Claimed services must be covered under patient's benefit package |
| AUT-008 | MAJOR | verify_referral_authorization | Referral must be authorized by referring facility |
| AUT-009 | HARD_STOP | verify_claim_within_7_day_window | Claim must be submitted within 7 days of service/discharge |
| AUT-010 | MAJOR | verify_no_duplicate_claim | Check for potential duplicate claims (dedup hash) |
| AUT-011 | MINOR | verify_copay_documented | Co-payment amount should be documented if applicable |
| AUT-012 | MAJOR | verify_emergency_retroauth | Emergency claims must have retroactive authorization documentation |
| AUT-013 | HARD_STOP | verify_patient_coverage_active_at_service | Patient coverage must be active on date of service |
| AUT-014 | MINOR | verify_referral_chain_complete | Full referral chain documented for tertiary referrals |
| AUT-015 | INFO | verify_authorization_completeness_score | Authorization documentation completeness score |

### FINANCIAL (20 rules)

| Rule ID | Severity | Logic Key | Description (EN) |
|---------|----------|-----------|-------------------|
| FIN-001 | HARD_STOP | verify_tariff_code_exists | SHA service code must exist in active tariff table |
| FIN-002 | HARD_STOP | verify_amount_within_tariff | Claimed amount must not exceed SHA tariff maximum |
| FIN-003 | MAJOR | verify_tariff_tier_matches | Tariff applied must match facility tier level |
| FIN-004 | MAJOR | verify_quantity_reasonable | Quantity of items/services must be clinically reasonable |
| FIN-005 | MAJOR | verify_no_unbundling | Services should not be unbundled to inflate claim |
| FIN-006 | MAJOR | verify_no_upcoding | Procedure codes should match documented complexity |
| FIN-007 | HARD_STOP | verify_total_matches_lines | Claim total must equal sum of line items |
| FIN-008 | MINOR | verify_unit_price_consistent | Unit prices should be consistent with SHA tariff rates |
| FIN-009 | MAJOR | verify_pharmacy_items_formulary | Pharmacy items should be in SHA formulary |
| FIN-010 | MAJOR | verify_los_charges_match_dates | Bed charges must match admission to discharge dates |
| FIN-011 | MINOR | verify_consultation_fee_appropriate | Consultation fee must match facility tier |
| FIN-012 | MAJOR | verify_surgical_fees_match_procedure | Surgical fees must correspond to documented procedures |
| FIN-013 | MINOR | verify_no_duplicate_line_items | Warn if identical line items appear more than once |
| FIN-014 | MAJOR | verify_maternity_package_rate | Maternity claims must use package rates where applicable |
| FIN-015 | MAJOR | verify_renal_session_rate | Dialysis claims must use per-session rates |
| FIN-016 | MINOR | verify_claim_total_within_expected_range | Total claim amount should be within expected range for diagnosis |
| FIN-017 | MAJOR | verify_icu_charges_justified | ICU charges require ICU admission documentation |
| FIN-018 | MINOR | verify_implant_costs_documented | Implant costs require separate documentation |
| FIN-019 | HARD_STOP | verify_benefit_limit_not_exceeded | Claim must not exceed annual benefit limit for patient |
| FIN-020 | INFO | verify_financial_completeness_score | Financial validation completeness score |

### STRUCTURAL (10 rules)

| Rule ID | Severity | Logic Key | Description (EN) |
|---------|----------|-----------|-------------------|
| STR-001 | HARD_STOP | verify_claim_has_minimum_one_line | Claim must have at least one line item |
| STR-002 | HARD_STOP | verify_claim_has_documents | Claim must have at least one document uploaded |
| STR-003 | MAJOR | verify_all_required_fields_present | All mandatory claim fields must be populated |
| STR-004 | MAJOR | verify_dates_logically_consistent | Admission date ≤ discharge date, service dates within admission period |
| STR-005 | MINOR | verify_line_item_numbering | Line items should be sequentially numbered |
| STR-006 | HARD_STOP | verify_claim_not_duplicate | Deduplication check (patient + facility + date + diagnosis) |
| STR-007 | MAJOR | verify_extraction_completeness | Minimum extraction confidence threshold met |
| STR-008 | MINOR | verify_document_page_count_reasonable | Total pages should not exceed 50 per claim |
| STR-009 | HARD_STOP | verify_rulepack_integrity | Rulepack checksum must match expected value |
| STR-010 | INFO | verify_overall_claim_quality_score | Composite quality score across all categories |

---

## 13. DOCUMENT TYPE TAXONOMY & PROCESSING ROUTES

### Processing Route Matrix

| Document Type | Processing Route | OCR? | Field Extraction? | Signature Detection? | Quality Check? |
|---------------|-----------------|------|-------------------|---------------------|----------------|
| SHA_CLAIM_FORM_OP | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| SHA_CLAIM_FORM_IP | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| SHA_CLAIM_FORM_MATERNITY | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| PREAUTH_FORM | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| DISCHARGE_SUMMARY | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| PHYSICIAN_NOTES | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| LAB_RESULTS | STRUCTURED_EXTRACT | ✅ | ✅ (tabular) | ❌ | ✅ |
| PRESCRIPTION | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| REFERRAL_LETTER | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| RADIOLOGY_REPORT | FULL_OCR_EXTRACT | ✅ | ✅ | ❌ | ✅ |
| OPERATIVE_NOTE | FULL_OCR_EXTRACT | ✅ | ✅ | ✅ | ✅ |
| NATIONAL_ID_COPY | EXISTENCE_QUALITY_ONLY | ❌ | ❌ | ❌ | ✅ |
| SHA_CARD_COPY | EXISTENCE_QUALITY_ONLY | ❌ | ❌ | ❌ | ✅ |
| CONSENT_FORM | SIGNATURE_DETECT_ONLY | ❌ | ❌ | ✅ | ✅ |
| OTHER_SUPPORTING | EXISTENCE_QUALITY_ONLY | ❌ | ❌ | ❌ | ✅ |

### Benefit Package → Required Documents

```yaml
# In rulepack params
benefit_package_docs:
  OUTPATIENT:
    required: [SHA_CLAIM_FORM_OP, PHYSICIAN_NOTES]
    conditional:
      - type: LAB_RESULTS
        if: "claim_lines.any(l => l.category == 'LAB')"
      - type: PRESCRIPTION
        if: "claim_lines.any(l => l.category == 'PHARMACY')"
      - type: REFERRAL_LETTER
        if: "claim.is_referral == true"
  INPATIENT:
    required: [SHA_CLAIM_FORM_IP, PHYSICIAN_NOTES, DISCHARGE_SUMMARY]
    conditional:
      - type: CONSENT_FORM
        if: "claim_lines.any(l => l.category == 'SURGICAL')"
      - type: OPERATIVE_NOTE
        if: "claim_lines.any(l => l.category == 'SURGICAL')"
  MATERNITY:
    required: [SHA_CLAIM_FORM_MATERNITY, PHYSICIAN_NOTES, DISCHARGE_SUMMARY]
```

---

## 14. FHIR R4 MAPPING & AFYALINK INTEGRATION

### Entity Mapping (ClaimFlow ↔ FHIR R4)

| ClaimFlow Entity | FHIR R4 Resource | AfyaLink Registry |
|-----------------|------------------|-------------------|
| `claims` | Claim | Claim submission endpoint |
| `patient_sha_id` | Patient | Client Registry (cr.kenya-hie.health) |
| admission/visit | Encounter | SHR |
| practitioner | Practitioner | Health Worker Registry |
| `facilities` | Organization | Facility Registry (fr.kenya-hie.health) |
| documents | DocumentReference | — |
| coverage | Coverage | Eligibility API |
| audit result (v2) | ClaimResponse | — (internal) |
| preauthorization | Claim (use: preauthorization) | SHA Portal Preauth API |

### AfyaLink FHIR Bundle Structure (Reference — v2 shadow validation)

Based on actual AfyaLink documentation, the FHIR Claim Bundle must contain these entries:

1. **Bundle** (type: "message", profile: StructureDefinition/bundle|1.0.0)
2. **Organization** (facility, from Facility Registry with FID-xx-xxxxxx-x format)
3. **Coverage** (patient coverage, from Eligibility check)
4. **Patient** (from Client Registry with CR identifier)
5. **Practitioner** (from Health Worker Registry with PUID identifier)
6. **Encounter** (visit details: class OP/IP, period, type)
7. **Claim** (the actual claim with diagnosis ICD-11, items with SHA service codes, billablePeriod, insurance reference)

### Key AfyaLink URLs (Parameterized)

```typescript
// packages/shared/src/constants/afyalink.ts

export const AFYALINK_URLS = {
  UAT: {
    base: 'https://uat-mis.apeiro-digital.com',
    claimSubmit: 'https://uat-mis.apeiro-digital.com/v1/shr-med/bundle',
    clientRegistry: 'https://cr.kenya-hie.health/api/v4/Patient',
    facilityRegistry: 'https://fr.kenya-hie.health/api/v4/Organization',
    eligibility: 'https://uat.dha.go.ke/v1/eligibility',
    preauth: 'https://uat.dha.go.ke/v1/shr-med/bundle',
    artifacts: 'https://kps.dha.go.ke/artifacts.html',
  },
  PRODUCTION: {
    base: 'https://mis.apeiro-digital.com',
    claimSubmit: 'https://mis.apeiro-digital.com/v1/shr-med/bundle',
    clientRegistry: 'https://cr.kenya-hie.health/api/v4/Patient',
    facilityRegistry: 'https://fr.kenya-hie.health/api/v4/Organization',
    eligibility: 'https://dha.go.ke/v1/eligibility',
    preauth: 'https://dha.go.ke/v1/shr-med/bundle',
  },
} as const;
```

### Coding Systems

| System | URL |
|--------|-----|
| ICD-11 Diagnosis | `https://<base>/fhir/terminology/CodeSystem/icd-11` |
| SHA Service Codes | `https://<base>/fhir/terminology/CodeSystem/sha-service-codes` |
| Claim Type | `http://terminology.hl7.org/CodeSystem/claim-type` |
| Claim Subtype | `http://terminology.hl7.org/CodeSystem/ex-claimsubtype` (op, ip, etc.) |
| Encounter Class | `http://terminology.hl7.org/CodeSystem/v3-ActCode` |
| Facility ID Type | `http://ts-kenyahie.health/facility-identifier-type` |
| SHA Number System | `https://<base>/fhir/identifier/shanumber` |

### Common SHA Rejection Reasons (mapped to ClaimFlow rules)

| SHA Rejection Reason | ClaimFlow Rule(s) |
|---------------------|-------------------|
| "Provider not found in HIE" | IDN-008, IDN-009 |
| "Mismatch in Facility Level" | IDN-009 |
| "Patient not found in Client Registry" | IDN-001 |
| "Invalid ICD code" | CLN-001, CLN-002 |
| "Service not covered under benefit package" | AUT-007 |
| "Preauthorization required" | AUT-001 |
| "Claim submission past 7-day window" | AUT-009 |
| "Duplicate claim" | AUT-010, STR-006 |
| "Amount exceeds tariff" | FIN-002 |

---

## 15. ML PIPELINE (CPU-REALISTIC)

### v1 Architecture

```
Document Upload
      │
      ▼
┌─────────────┐
│ Image Quality│ ──── Blur/Skew/DPI check
│   Check      │      (OpenCV, ~50ms/page)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Document    │ ──── MobileNet v3 (trained on SHA forms)
│ Classifier   │      (~200ms/doc, <50MB model)
└──────┬──────┘
       │
       ▼ (route by doc type)
       │
  ┌────┴────────────────────┐
  │                          │
  ▼                          ▼
FULL_OCR_EXTRACT    EXISTENCE_QUALITY_ONLY
  │                          │
  ▼                          ▼
┌──────────┐         ┌──────────┐
│ Tesseract│         │ Return   │
│ 5 + PPOCR│         │ {exists, │
│ Ensemble │         │  quality}│
│ ~2s/page │         └──────────┘
└────┬─────┘
     │
     ▼
┌──────────┐
│  Field   │ ──── Regex + positional heuristics
│ Extract  │      for known form layouts
└────┬─────┘
     │
     ▼
┌──────────┐
│ Signature│ ──── Contour analysis + ink density
│ Detect   │      (~100ms/page, no model needed)
└────┬─────┘
     │
     ▼
  Results JSON
```

### ML Service Endpoints (FastAPI)

**POST /ml/process-document** — Full document processing

```python
# Request
{
    "document_id": "uuid",
    "storage_path": "/data/docs/tenant/claim/doc.pdf",
    "doc_type": "SHA_CLAIM_FORM_OP",
    "processing_route": "FULL_OCR_EXTRACT",
    "pages": [1, 2, 3]  # Specific pages, or empty for all
}

# Response
{
    "document_id": "uuid",
    "pages": [
        {
            "page_number": 1,
            "status": "COMPLETED",
            "image_quality": {
                "score": 0.87,
                "blur_score": 0.92,
                "skew_degrees": 1.2,
                "dpi_estimated": 300
            },
            "ocr": {
                "engine": "ensemble",
                "raw_text": "...",
                "confidence": 0.84,
                "word_count": 245
            },
            "fields": [
                {
                    "field_key": "patient_name",
                    "value": "JOHN DOE",
                    "confidence": 0.91,
                    "confidence_tier": "HIGH",
                    "bbox": {"x": 120, "y": 85, "w": 280, "h": 30},
                    "source": "OCR"
                }
            ],
            "signatures": [
                {
                    "type": "SIGNATURE",
                    "present": true,
                    "confidence": 0.78,
                    "bbox": {"x": 400, "y": 650, "w": 150, "h": 60}
                },
                {
                    "type": "STAMP",
                    "present": true,
                    "confidence": 0.85,
                    "bbox": {"x": 380, "y": 620, "w": 100, "h": 100}
                }
            ]
        }
    ],
    "document_class": {
        "predicted": "SHA_CLAIM_FORM_OP",
        "confidence": 0.94,
        "alternatives": [
            {"class": "SHA_CLAIM_FORM_IP", "confidence": 0.04}
        ]
    },
    "processing_time_ms": 4200
}
```

**GET /ml/health** — ML service health check

### OCR Confidence Thresholds (configurable per facility)

| Tier | Range | UI Behavior | Officer Action |
|------|-------|-------------|---------------|
| HIGH | > 0.85 | No highlight | Auto-accepted |
| MEDIUM | 0.60 – 0.85 | Yellow highlight | Optional review |
| LOW | < 0.60 | Red highlight | MUST review before audit |

**Threshold:** If > 40% of extracted fields on a document are LOW confidence → document flagged as `MANUAL_ENTRY_REQUIRED`.

### Partial Failure Handling

1. Each page is processed independently.
2. If a page fails OCR: retry up to 3 times with increasing timeout.
3. After 3 failures: mark page as `FAILED`, set document_pages.status = `FAILED`.
4. Audit can still proceed: rules that depend on data from failed pages return `INCOMPLETE`.
5. `INCOMPLETE` rules contribute to a WARNING but not HARD_STOP (configurable per rule).
6. UI shows per-page status with retry button for failed pages.

### v1.5/v2 Escalation

- **LayoutLMv3**: Add only if field extraction accuracy from Tesseract+regex is below 80% F1.
- **TrOCR**: Add for handwriting only when corrections dataset reaches 5,000+ samples.
- **Hardware requirement for heavy models**: 16 CPU / 64GB RAM / optional NVIDIA GPU.
- **Cloud inference tier**: Pro subscribers can optionally route heavy OCR to cloud endpoint (PHI stays encrypted in transit with facility-specific key, processed and discarded).

---

## 16. AUDIT WORKSPACE UX SPECIFICATION

### Layout

```
┌────────────────────────────────────────────────────┐
│ Header: Claim #12345 | Status: FAILED | v1.2.3     │
│ [← Back to Claims] [Re-audit] [Override] [Export]   │
├──────────────────────┬─────────────────────────────┤
│                      │                               │
│   Document Viewer    │   Extraction Editor           │
│   (Left Panel ~55%)  │   (Right Panel ~45%)          │
│                      │                               │
│   ┌──────────────┐  │   Field: Patient Name          │
│   │              │  │   Value: [JOHN DOE_______]  ✅ │
│   │  Scanned     │  │                               │
│   │  Document    │  │   Field: SHA ID                │
│   │  Page 1/3    │  │   Value: [CR00000001-1__]  ⚠️ │
│   │              │  │                               │
│   │  [bbox       │  │   Field: Diagnosis             │
│   │   highlight] │  │   Value: [1A00__________]  🔴 │
│   │              │  │                               │
│   └──────────────┘  │   Field: Physician Sig         │
│   [◄ Prev] [Next ►] │   Value: [DETECTED: 78%]  ⚠️ │
│                      │                               │
│   Page: 1 2 3        │   [Accept All HIGH] [Save]    │
│                      │                               │
├──────────────────────┴─────────────────────────────┤
│ Fix Report (collapsible bottom panel)               │
│ ❌ IDN-001: Patient SHA ID not found in registry    │
│ ⚠️ CLN-003: Diagnosis may not match claim type      │
│ ✅ 98 rules passed                                  │
└────────────────────────────────────────────────────┘
```

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `Tab` | Move to next LOW or MEDIUM confidence field |
| `Shift+Tab` | Move to previous LOW or MEDIUM confidence field |
| `Enter` | Confirm current field correction |
| `Ctrl+A` | Accept all HIGH confidence fields |
| `Ctrl+S` | Save current corrections |
| `Ctrl+Z` | Undo last correction |
| `Ctrl+Shift+Z` | Redo |
| `←` / `→` | Previous / Next document page |
| `Ctrl+Enter` | Trigger re-audit with current corrections |
| `Esc` | Close modal / deselect field |

### Bidirectional Linking
- Click a field in the editor → corresponding bounding box highlights on the document viewer (blue overlay with animation).
- Click a bounding box on the document → corresponding field scrolls into view and focuses in the editor.
- If no bbox available (manual field), document viewer shows the full page.

### Auto-Save
- Corrections auto-save every 5 seconds when changes are detected.
- Visual indicator: "Saved ✓" or "Saving..." in header.
- On navigation away from page: prompt if unsaved changes exist.

### Confidence Display
- HIGH (>0.85): Green checkmark ✅, no background
- MEDIUM (0.60–0.85): Yellow warning ⚠️, light yellow background
- LOW (<0.60): Red circle 🔴, light red background, field is pre-focused on page load

### Responsive Behavior
- Desktop (>1200px): side-by-side panels as shown
- Tablet (768–1200px): stacked panels with tab toggle (Document / Editor)
- Mobile: not supported for audit workspace (show redirect message)

---

## 17. DASHBOARD SPECIFICATION

### Main Dashboard (Claims Officer + Supervisor)

**Top Bar:** Facility name | Date range picker (Today / This Week / This Month / Custom) | Language toggle (EN/SW)

**Summary Cards Row:**
- Claims Today: {count} (↑/↓ vs yesterday)
- Pass Rate: {%} (trend arrow)
- Pending Audit: {count}
- Avg Audit Time: {minutes}
- ML Status: {UP/DOWN/DEGRADED}

**Claims Table:**
Sortable, filterable table showing claims. Columns: Status badge, Claim ID (clickable), Patient SHA ID, Type, Admission Date, Documents, Last Audit Decision, Amount (KES), Created, Actions (Audit / View / Export).

Filter bar: Status dropdown (multi-select), Type dropdown, Date range, Free text search.

**Charts (below table):**
1. Pass/Fail/Warning trend line (daily, last 30 days)
2. Top 10 failing rules bar chart (with rule ID + short message)
3. Claims by type pie chart
4. Document quality by type (average OCR confidence per doc type)

### Admin Dashboard (additional panels)

- Officer Productivity table (claims/day per officer, avg time, corrections)
- Rulepack Management (current version, available updates, activate/rollback buttons)
- System Health (disk usage, DB pool, ML service status, job queue depth)
- Sync Status (last sync time, pending events, errors)
- License Status (tier, expiry, features)

---

## 18. AUTHENTICATION & AUTHORIZATION

### Password Policy
- Minimum 12 characters
- Must include: uppercase, lowercase, digit, special character
- Cannot reuse last 5 passwords
- Maximum age: 90 days (force change prompt)
- Bcrypt with cost factor 12

### Account Lockout
- Lock after 5 consecutive failed login attempts
- Lockout duration: 15 minutes (progressive: 15min, 30min, 1hr, then admin-unlock only)
- Lockout events logged to audit_trail

### Password Reset
- Admin-only reset (no email-based self-service in v1 — hospitals may not have reliable email)
- Admin sets temporary password + `must_change_password = true`
- Officer changes password on next login

### Session Management
- Access token: JWT RS256, 15-minute expiry
- Refresh token: opaque, 7-day expiry, rotation on each refresh
- Refresh token family: if a used refresh token is resubmitted, revoke entire family (detect token theft)
- Idle timeout: 30 minutes of inactivity → require re-authentication
- Step-up MFA: required for override approval, evidence export, admin actions, rulepack activation

### RBAC Permission Matrix

| Permission | super_admin | admin | supervisor | claims_officer | auditor | viewer |
|-----------|:-:|:-:|:-:|:-:|:-:|:-:|
| Create claim | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Upload documents | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Trigger audit | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Correct fields | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Request override | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Approve override | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Export evidence pack | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| View dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Manage users | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Activate rulepack | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| View audit trail | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| System settings | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

---

## 19. ENCRYPTION & KEY MANAGEMENT

### At-Rest Encryption

**Disk-level:** Ubuntu LUKS full-disk encryption on the server SSD.

**Application-level (PHI fields):** AES-256-GCM encryption for:
- `claims.patient_name_enc`
- `claims.patient_national_id_enc`
- `extracted_fields.field_value` (when field_key is in PHI field list)
- `mfa_devices.secret_encrypted`

### Key Management (v1 — single server)

```
/etc/claimflow/keys/
├── master.key              # 256-bit AES master key (chmod 600, owned by claimflow user)
├── jwt-private.pem         # RSA 2048 private key for JWT signing
└── jwt-public.pem          # RSA 2048 public key for JWT verification
```

- Master key loaded into memory at API startup. Never logged, never in env vars.
- Application derives per-field encryption keys using HKDF from master key + field identifier.
- Key rotation: sync agent can deliver new keys from control plane. Old keys kept in `keys/archive/` for decryption of existing data. Re-encryption job runs in background.
- JWT key rotation: new keypair generated every 90 days. Old public key retained for 24 hours for token validation.

### In-Transit Encryption
- All internal service communication over Docker network (trusted).
- All external API calls: TLS 1.3 with certificate pinning for AfyaLink endpoints.
- Web UI: HTTPS with hospital-provided or auto-generated certificate.

---

## 20. EXTERNAL INTEGRATIONS

### Circuit Breaker Pattern

All external API calls use a circuit breaker:

```typescript
interface CircuitBreakerConfig {
  failureThreshold: 5;        // Failures before opening
  resetTimeout: 300_000;      // 5 minutes in ms
  halfOpenRequests: 1;        // Requests to allow in half-open state
  timeout: 10_000;            // Request timeout in ms
}

// States: CLOSED → OPEN → HALF_OPEN → CLOSED
```

### Client Registry (Patient Lookup)

- **Endpoint:** `GET https://cr.kenya-hie.health/api/v4/Patient?identifier={sha_id}`
- **Auth:** Bearer JWT (obtained from AfyaLink developer portal)
- **Cache:** 24-hour TTL in `registry_cache` table
- **Degraded behavior:** If unavailable, rules IDN-001/003 return INCOMPLETE. Configurable per rulepack as HARD_STOP or WARNING.

### Facility Registry

- **Endpoint:** `GET https://fr.kenya-hie.health/api/v4/Organization?identifier={facility_id}`
- **Cache:** 7-day TTL (facilities don't change often)
- **Used by:** Rules IDN-008, IDN-009

### Health Worker Registry

- **Endpoint:** Lookup by PUID (Practitioner Unique ID)
- **Cache:** 7-day TTL
- **Used by:** Rules IDN-010, IDN-011, IDN-012

### Eligibility API (v2)

- **Endpoint:** `POST https://dha.go.ke/v1/eligibility`
- **Purpose:** Verify patient has active SHIF/ECCIF coverage on date of service
- **Response fields:** eligible (0/1), reason, coverage end date, benefit packages

### Degraded Mode UI

When any circuit breaker opens:
- Dashboard banner: "⚠️ External registry unavailable. Running in degraded mode. Claims will be audited with local data only."
- Audit trail logs `SYSTEM_DEGRADED_MODE_ENTERED`
- Affected rules show result `INCOMPLETE` with evidence `{ reason: "registry_unavailable" }`

---

## 21. QUEUEING & WORKFLOW ORCHESTRATION

### Job Queue (pg-boss)

```typescript
// Job types
type JobType =
  | 'process-document'        // OCR + extraction pipeline for one document
  | 'run-audit'              // Execute rule engine for one claim
  | 'batch-audit'            // Orchestrate batch of individual audits
  | 'generate-export'        // Create evidence pack ZIP
  | 'sync-rulepack'          // Download + validate new rulepack
  | 'sync-metrics'           // Upload anonymized metrics
  | 'cleanup-expired'        // Purge expired cache, idempotency keys
  | 'backup-database';       // Trigger pg_dump + WAL archive

// Retry policy
const retryConfig = {
  'process-document': { retryLimit: 3, retryDelay: 30, retryBackoff: true },
  'run-audit':        { retryLimit: 2, retryDelay: 10 },
  'batch-audit':      { retryLimit: 1, retryDelay: 60 },
  'generate-export':  { retryLimit: 2, retryDelay: 30 },
};

// Scheduled jobs
const scheduleConfig = {
  'cleanup-expired':  { cron: '0 * * * *' },       // Hourly
  'sync-metrics':     { cron: '0 */6 * * *' },     // Every 6 hours
  'backup-database':  { cron: '0 2 * * *' },       // Daily at 2 AM
};
```

### Audit Pipeline Orchestrator

```typescript
// packages/api/src/workflows/audit-pipeline.ts

async function executeAuditPipeline(claimId: string, userId: string): Promise<AuditSession> {
  const claim = await claimService.getWithDocuments(claimId);

  // 1. Transition state
  await stateMachine.transition(claim, 'PROCESSING');

  // 2. Process documents (parallel per document, serial per page)
  const extractionResults = await Promise.allSettled(
    claim.documents.map(doc => processDocument(doc))
  );

  // 3. Handle partial failures
  const fields = collectExtractedFields(extractionResults);
  const failedDocs = extractionResults.filter(r => r.status === 'rejected');

  // 4. Fetch external data (with circuit breakers + cache)
  const registryResults = await fetchRegistryData(claim);

  // 5. Load tariffs
  const tariffs = await tariffService.getActiveTariffs();

  // 6. Execute rule engine (deterministic)
  const ruleOutput = ruleEngine.evaluate({
    claim: claim.toSnapshot(),
    extractedFields: fields,
    documents: claim.documents.map(d => d.toSummary()),
    facilityContext: await facilityService.getContext(claim.facilityId),
    tariffs,
    registryResults,
  });

  // 7. Persist results
  const session = await auditService.createSession({
    claimId, userId,
    decision: ruleOutput.decision,
    results: ruleOutput.results,
    fixReportMd: ruleOutput.fixReportMarkdown,
    executionTimeMs: ruleOutput.executionTimeMs,
    rupackVersion: ruleEngine.activeVersion(),
  });

  // 8. Generate PDF fix report
  await queue.send('generate-fix-report-pdf', { sessionId: session.id });

  // 9. Transition to final state
  await stateMachine.transition(claim, ruleOutput.decision); // PASSED | FAILED | WARNING

  // 10. Log audit trail
  await auditTrail.log({
    claimId, userId,
    action: 'AUDIT_COMPLETED',
    detail: { sessionId: session.id, decision: ruleOutput.decision },
  });

  return session;
}
```

### Timeout Handling
- Document processing timeout: 60 seconds per document (kill and mark FAILED)
- Rule engine timeout: 10 seconds (should never be reached — rules are fast)
- External API timeout: 10 seconds (handled by circuit breaker)
- Overall pipeline timeout: 120 seconds (fail entire audit, return partial results)

### Compensation / Recovery
- If pipeline fails mid-way: claim stays in PROCESSING state.
- A scheduled job detects claims stuck in PROCESSING for >5 minutes → marks as FAILED with error "Pipeline timeout — please retry."
- All audit_sessions have a `completed_at` field. Null = incomplete. Incomplete sessions don't count as valid audits.

---

## 22. STORAGE ARCHITECTURE

### DocumentStore Interface

```typescript
interface DocumentStore {
  put(tenantId: string, claimId: string, docId: string, buffer: Buffer, mimeType: string): Promise<string>;  // Returns storage_path
  get(storagePath: string): Promise<Buffer>;
  getStream(storagePath: string): Promise<Readable>;
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
}
```

### v1: LocalFileStore

```
/data/
├── docs/
│   └── {tenant_id}/
│       └── {claim_id}/
│           ├── {doc_id}.pdf
│           ├── {doc_id}.jpg
│           └── pages/
│               ├── {doc_id}_p1.png     # Extracted page images
│               ├── {doc_id}_p2.png
│               └── ...
├── exports/
│   └── {tenant_id}/
│       └── {claim_id}/
│           └── {audit_id}.zip
├── rulepacks/
│   ├── v1.0.0/
│   ├── v1.1.0/
│   └── v1.2.0/
├── models/                              # ML model files
│   ├── doc_classifier_v1.onnx
│   └── ...
├── backups/
│   ├── daily/
│   └── wal/
└── keys/                                # Symlink to /etc/claimflow/keys
```

### File Size Limits
- Single document upload: 50 MB
- Total documents per claim: 200 MB
- Maximum pages per document: 50
- Accepted MIME types: `application/pdf`, `image/jpeg`, `image/png`, `image/tiff`

---

## 23. OBSERVABILITY & LOGGING

### v1 Logging Strategy

**Format:** JSON structured logs to stdout (Docker captures) + file with logrotate.

```json
{
  "timestamp": "2026-03-05T10:30:00.123Z",
  "level": "info",
  "service": "api",
  "requestId": "req-abc-123",
  "tenantId": "tenant-uuid",
  "userId": "user-uuid",
  "action": "audit.completed",
  "claimId": "claim-uuid",
  "decision": "PASSED",
  "executionTimeMs": 3450,
  "rulesExecuted": 118,
  "msg": "Audit completed successfully"
}
```

**PHI Redaction:** Logger middleware strips PHI fields (patient_name, national_id) from all log output. Log only UUIDs and SHA IDs.

**Log Levels:**
- `error`: Unhandled exceptions, data corruption, security events
- `warn`: Circuit breaker opens, degraded mode, high queue depth, slow queries
- `info`: Audit completions, state transitions, user logins, rulepack activations
- `debug`: Individual rule evaluations, OCR per-page results (disabled in production)

**Logrotate:** Daily rotation, keep 30 days, compress after 1 day.

### /metrics Endpoint

Key counters and histograms exposed at `GET /metrics` (internal network only, no auth):

- `claimflow_claims_total{status, claim_type, facility_id}`
- `claimflow_audit_duration_seconds` (histogram)
- `claimflow_ocr_confidence` (histogram)
- `claimflow_rule_failures_total{rule_id, category, severity}`
- `claimflow_job_queue_depth{job_type}`
- `claimflow_ml_requests_total{endpoint, status}`
- `claimflow_ml_latency_seconds{endpoint}` (histogram)
- `claimflow_http_requests_total{method, path, status}`
- `claimflow_http_duration_seconds{method, path}` (histogram)
- `claimflow_db_pool{state}` (active, idle, waiting)

---

## 24. SUBSCRIPTION & LICENSING

### Tiers

| Feature | Free | Pro |
|---------|------|-----|
| Manual claim entry | ✅ | ✅ |
| Deterministic rule engine | ✅ | ✅ |
| Basic dashboard | ✅ | ✅ |
| Document upload | ✅ | ✅ |
| OCR (Tesseract) | ✅ | ✅ |
| PaddleOCR ensemble | ❌ | ✅ |
| Document classification | ❌ | ✅ |
| Signature/stamp detection | ❌ | ✅ |
| Handwriting OCR (v2) | ❌ | ✅ |
| Advanced analytics | ❌ | ✅ |
| Batch audit | ❌ | ✅ |
| Evidence pack export | ❌ | ✅ |
| Officer productivity reports | ❌ | ✅ |
| Priority support | ❌ | ✅ |
| Custom rulepack parameters | ❌ | ✅ |

### License Token Structure

```typescript
interface LicenseToken {
  iss: 'claimflow-control-plane';
  sub: string;           // facility_id
  tier: 'FREE' | 'PRO';
  features: string[];    // ['paddle_ocr', 'batch_audit', 'export', 'doc_classifier', ...]
  facilityId: string;
  tenantId: string;
  iat: number;           // Issued at (Unix timestamp)
  exp: number;           // Expiry (Unix timestamp)
}
// Signed with RS256 by control plane private key
// Verified locally with embedded public key
```

### Offline Grace Period
- License validated locally using embedded public key (no phone-home).
- If license expired: 30-day grace period before features degrade.
- After grace: Pro features disabled, system continues operating on Free tier.
- Sync agent attempts license renewal on every sync cycle.

### Pro Feature Gating
- ML model files for Pro features (PaddleOCR, doc classifier) are AES-256 encrypted.
- Decryption key is derived from the Pro license token.
- Free tier gets Tesseract-only OCR and manual document type selection.

## 25. MULTI-TENANT ARCHITECTURE

### Isolation Strategy

Every database query MUST include `tenant_id` in the WHERE clause. This is enforced by:

1. **Fastify middleware** that extracts `tenant_id` from the JWT and attaches it to the request context.
2. **Database query layer** that automatically injects `AND tenant_id = $tenantId` into every query. Queries without tenant_id are rejected at compile time (TypeScript branded types).
3. **Row-Level Security (RLS)** as a defense-in-depth layer (not the primary mechanism due to performance considerations with pg-boss).

```typescript
// packages/api/src/plugins/tenant.ts
// Branded type ensures tenant_id is always present
type TenantId = string & { __brand: 'TenantId' };

interface TenantContext {
  tenantId: TenantId;
  facilityId: string | null;
  userId: string;
  role: UserRole;
}

// Every route handler receives this from the decorated request
fastify.decorateRequest('tenant', null);
```

### Data Isolation
- Each facility's documents stored in separate filesystem directories.
- Encryption keys can be per-tenant (v2) for complete cryptographic isolation.
- Sync agent transmits data tagged with facility_id; control plane never mixes facility data.

---

## 26. SYNC AGENT & HYBRID CLOUD

### Sync Agent Architecture

The sync agent runs as a periodic process (cron-style via pg-boss scheduled jobs) within the API container. It handles bidirectional communication with the central control plane.

### Governance Modes

| Mode | What Goes UP | What Comes DOWN |
|------|-------------|-----------------|
| `METRICS_ONLY` (default) | Claim counts, pass/fail rates, rule failure frequencies, audit latency stats, ML error counts — NO claim data, NO PHI | Rulepacks, ML models, software updates, license tokens |
| `DEIDENTIFIED` | Above + anonymized claim snapshots (SHA IDs hashed, names removed, dates shifted) for model training | Same as above |
| `FULL_ANALYTICS` | Above + facility-level claim summaries with service codes and amounts (still no patient names) | Same as above + facility benchmarking reports |

### Metrics Payload (METRICS_ONLY)

```json
{
  "facilityId": "uuid",
  "period": { "from": "2026-03-04T00:00:00Z", "to": "2026-03-05T00:00:00Z" },
  "claims": {
    "created": 45,
    "byStatus": { "PASSED": 32, "FAILED": 8, "WARNING": 5 },
    "byType": { "OUTPATIENT": 30, "INPATIENT": 10, "MATERNITY": 5 }
  },
  "audit": {
    "total": 42,
    "avgLatencyMs": 4500,
    "p95LatencyMs": 12000
  },
  "ruleFailures": [
    { "ruleId": "IDN-001", "count": 12 },
    { "ruleId": "DOC-003", "count": 8 }
  ],
  "ml": {
    "avgOcrConfidence": 0.82,
    "documentsProcessed": 156,
    "manualEntryRequired": 3,
    "errors": 2
  },
  "system": {
    "uptime": 86400,
    "diskUsagePercent": 45,
    "rupackVersion": "1.2.0"
  }
}
```

### Rulepack Update Flow

1. Sync agent polls control plane: `GET /api/v1/rulepacks/latest?current={version}`
2. If new version available: download YAML + checksum
3. Validate checksum. Parse and validate YAML structure.
4. Insert into `rulepacks` table with `is_activated = false`.
5. Notify admin via dashboard: "New rulepack v1.3.0 available."
6. Admin reviews changes and clicks "Activate" (requires step-up MFA).
7. System sets `is_activated = true`, `activated_at = now()`.
8. Rule engine reloads active rulepack on next audit request.
9. If issues: admin clicks "Rollback" to previous version. System keeps last 3.

---

## 27. ONBOARDING & FACILITY SETUP

### First-Run Setup Flow

```bash
# 1. Hospital IT runs setup script
./scripts/setup.sh

# Script performs:
# - Check system requirements (CPU, RAM, disk, Docker)
# - Generate encryption keys (master.key, jwt keypair)
# - Initialize PostgreSQL with migrations
# - Create default tenant and facility
# - Create super_admin user (prompt for email + password)
# - Import reference data (ICD-11 codes, SHA service codes)
# - Activate bundled rulepack v1.0.0
# - Run health checks on all services
# - Generate facility registration token for control plane
```

### Facility Registration Sequence

1. **Local setup:** `setup.sh` creates the facility locally and generates a registration payload.
2. **Control plane registration:** Admin visits control plane web portal, enters registration code displayed by setup.sh.
3. **License provisioning:** Control plane validates, creates facility record, and issues initial license token (Free tier).
4. **Sync activation:** Sync agent receives license token + control plane URL. First sync pulls latest rulepack.

### Test/Training Mode

```bash
# Seed sample data for officer training
./scripts/seed-test-data.sh

# Creates:
# - 20 sample claims across all types (OP, IP, Maternity, etc.)
# - With sample documents (PDF forms with realistic data)
# - Pre-populated extraction fields (some correct, some with errors)
# - Officers can practice the full audit workflow
# - Test data is tagged with is_test=true and excluded from analytics
```

### HMIS Data Import (Optional)

If the hospital has an existing HMIS with claim data:
- CSV import endpoint: `POST /v1/admin/import/claims` (admin only)
- Accepts CSV with columns mapping to claim fields
- Validates, creates claims in DRAFT status
- Officers then upload documents and run audits normally

---

## 28. BACKUP, RECOVERY & DATA RETENTION

### Backup Strategy

| Component | Method | Frequency | Retention | RPO |
|-----------|--------|-----------|-----------|-----|
| PostgreSQL | WAL archiving (continuous) | Continuous | 7 days of WAL | < 1 hour |
| PostgreSQL | pg_dump (full) | Daily at 2 AM | 30 days | 24 hours |
| Documents | rsync to backup storage | Daily at 3 AM | Same as claims | 24 hours |
| Rulepacks | Included in pg_dump | With DB | Indefinite | — |
| Config/keys | Manual backup on change | On change | 3 versions | — |

### Backup Locations
- **Primary:** `/data/backups/` on server
- **Secondary:** External USB drive (rotated weekly) or network-attached storage
- **Optional:** Encrypted upload to control plane (if facility opts in)

### Recovery Procedure

```bash
# Full disaster recovery
./scripts/restore.sh <backup_date>

# Script performs:
# 1. Stop all services
# 2. Restore PostgreSQL from dump + WAL replay
# 3. Restore documents from backup
# 4. Verify data integrity (checksums)
# 5. Run migrations (in case backup is from older version)
# 6. Restart services
# 7. Health check
```

**RTO Target:** System restored within 2 hours.

### Backup Verification
- Monthly automated restore test: pg_dump → restore to temporary database → run integrity queries → report.
- Logged in audit_trail as `BACKUP_VERIFIED`.

### Data Retention Policy

| Data Type | Retention Period | After Retention |
|-----------|-----------------|-----------------|
| Claims + audit results | 7 years (Kenya healthcare records requirement) | Archive to compressed storage |
| Documents (original uploads) | 7 years | Archive to compressed storage |
| Extracted fields / OCR text | 3 years | Purge |
| Corrections (training data) | Indefinite (anonymized) | Retain for ML improvement |
| Audit trail | 7 years | Archive (never delete) |
| Registry cache | 30 days | Auto-purge (scheduled job) |
| Idempotency keys | 24 hours | Auto-purge (scheduled job) |
| Job queue history | 30 days | Auto-purge (pg-boss built-in) |
| Logs | 90 days | Rotate + compress |

---

## 29. DEPLOYMENT (DOCKER COMPOSE)

### v1 Minimal Compose (Recommended)

```yaml
# docker/docker-compose.yml

name: claimflow

services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: claimflow
      POSTGRES_USER: claimflow
      POSTGRES_PASSWORD: "${DB_PASSWORD:?DB_PASSWORD required}"
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./data/backups/wal:/var/lib/postgresql/wal_archive
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U claimflow -d claimflow"]
      interval: 10s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'
    command: >
      postgres
      -c wal_level=replica
      -c archive_mode=on
      -c archive_command='cp %p /var/lib/postgresql/wal_archive/%f'
      -c max_connections=100
      -c shared_buffers=1GB
      -c work_mem=16MB

  api:
    build:
      context: ..
      dockerfile: docker/Dockerfile.api
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "${API_PORT:-8080}:8080"
    environment:
      NODE_ENV: production
      DATABASE_URL: "postgres://claimflow:${DB_PASSWORD}@postgres:5432/claimflow"
      STORAGE_PATH: /data
      ML_SERVICE_URL: http://ml:8000
      RULEPACK_DIR: /data/rulepacks
      KEY_PATH: /etc/claimflow/keys
      LOG_LEVEL: info
      REQUIRE_MFA: "true"
      LICENSE_TOKEN: "${LICENSE_TOKEN}"
      CONTROL_PLANE_URL: "${CONTROL_PLANE_URL:-}"
      SYNC_GOVERNANCE_MODE: "${SYNC_MODE:-METRICS_ONLY}"
      RATE_LIMIT_RPM: "100"
      MAX_UPLOAD_SIZE_MB: "50"
    volumes:
      - app_data:/data
      - keys:/etc/claimflow/keys:ro
      - rulepacks:/data/rulepacks:ro
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3

  web:
    build:
      context: ..
      dockerfile: docker/Dockerfile.web
    restart: unless-stopped
    depends_on:
      api:
        condition: service_healthy
    ports:
      - "${WEB_PORT:-3000}:3000"
    environment:
      NEXT_PUBLIC_API_URL: "http://api:8080"
      NEXT_PUBLIC_DEFAULT_LOCALE: en
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '0.5'

  ml:
    build:
      context: ..
      dockerfile: docker/Dockerfile.ml
    restart: unless-stopped
    ports:
      - "${ML_PORT:-8000}:8000"
    environment:
      STORAGE_PATH: /data
      OCR_ENGINE: "tesseract+paddleocr"
      CONF_THRESHOLD_HIGH: "${CONF_HIGH:-0.85}"
      CONF_THRESHOLD_LOW: "${CONF_LOW:-0.60}"
      MAX_PAGES_PER_REQUEST: "50"
      PROCESSING_TIMEOUT_SECONDS: "60"
    volumes:
      - app_data:/data
      - models:/data/models:ro
    deploy:
      resources:
        limits:
          memory: 8G
          cpus: '4'
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  pg_data:
  app_data:
  keys:
  rulepacks:
  models:
```

### Resource Allocation Summary (8 CPU / 32GB server)

| Service | CPU Limit | Memory Limit | Notes |
|---------|-----------|-------------|-------|
| PostgreSQL | 2 cores | 4 GB | Shared buffers, WAL, connections |
| API + Rule Engine | 2 cores | 2 GB | Fastify + pg-boss workers |
| ML Service | 4 cores | 8 GB | Tesseract + PaddleOCR (CPU-bound) |
| Web (Next.js) | 0.5 cores | 512 MB | SSR + static serving |
| OS + Docker | ~1 core | ~2 GB | Overhead |
| **Buffer** | **~0.5 cores** | **~15.5 GB** | Available for spikes |

---

## 30. UPDATE & ROLLBACK PROCEDURES

### Software Update Flow

1. Sync agent detects new version available from control plane.
2. Downloads new Docker images to local registry.
3. Admin notified: "ClaimFlow v1.3.0 available. Changes: [changelog]."
4. Admin schedules update (during low-activity period, e.g., 10 PM).
5. Update script:
   ```bash
   ./scripts/update.sh v1.3.0
   # Steps:
   # 1. Create full database backup
   # 2. Pull new images
   # 3. Run database migrations (if any)
   # 4. Rolling restart: web → api → ml (one at a time)
   # 5. Health check all services
   # 6. If health check fails → automatic rollback
   ```

### Rollback Procedure

```bash
./scripts/rollback.sh
# Steps:
# 1. Stop current services
# 2. Restore previous Docker images
# 3. If migration was applied: restore database from pre-update backup
# 4. Start services with previous version
# 5. Health check
```

### Version Compatibility Matrix

| API Version | Rulepack Compatibility | DB Migration Required |
|-------------|----------------------|----------------------|
| 1.0.x | v1.0.x – v1.99.x | No (patch) |
| 1.1.x | v1.0.x – v1.99.x | Yes (minor) |
| 2.0.x | v2.0.x+ | Yes (major) |

---

## 31. TEST STRATEGY

### Coverage Targets

| Package | Unit Test Coverage | Requirement |
|---------|-------------------|-------------|
| @claimflow/rule-engine | **100%** | Every rule: at least 1 PASS + 1 FAIL test case |
| @claimflow/shared | 90% | All validation schemas, state machine transitions |
| @claimflow/api | 80% | All route handlers, services, middleware |
| @claimflow/web | 60% | Key components, critical user flows |
| ml-service | 70% | All endpoints, OCR pipeline, quality checks |

### Test Tooling

| Tool | Purpose |
|------|---------|
| Vitest | Unit + integration tests (TypeScript packages) |
| pytest | Unit tests (Python ML service) |
| Testcontainers | Spin up real Postgres for integration tests |
| Playwright | E2E browser tests |
| k6 | Load testing (optional, pre-deployment) |

### Rule Engine Testing

Every rule in the catalog must have a test file:

```typescript
// packages/rule-engine/__tests__/rules/identity/IDN-001.test.ts

describe('IDN-001: verify_patient_sha_id_exists', () => {
  it('should PASS when patient SHA ID exists in registry', () => {
    const input = createRuleInput({
      claim: { patientShaId: 'CR0000000001-1' },
      registryResults: { patient: { found: true, data: { ... } } },
    });
    const result = evaluateRule('IDN-001', input);
    expect(result.result).toBe('PASS');
  });

  it('should FAIL when patient SHA ID not found', () => {
    const input = createRuleInput({
      claim: { patientShaId: 'CR9999999999-9' },
      registryResults: { patient: { found: false } },
    });
    const result = evaluateRule('IDN-001', input);
    expect(result.result).toBe('FAIL');
    expect(result.evidence?.field).toBe('patient_sha_id');
  });

  it('should return INCOMPLETE when registry unavailable', () => {
    const input = createRuleInput({
      claim: { patientShaId: 'CR0000000001-1' },
      registryResults: { patient: null },  // Circuit breaker open
    });
    const result = evaluateRule('IDN-001', input);
    expect(result.result).toBe('INCOMPLETE');
  });

  it('should FAIL when SHA ID is empty', () => {
    const input = createRuleInput({
      claim: { patientShaId: '' },
    });
    const result = evaluateRule('IDN-001', input);
    expect(result.result).toBe('FAIL');
  });
});
```

### Integration Tests

```typescript
// tests/integration/audit-pipeline.test.ts

describe('Audit Pipeline', () => {
  let db: PostgresContainer;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startPostgresContainer();
    await runMigrations(db.getConnectionString());
    await seedRulepack(db);
    app = await buildApp({ databaseUrl: db.getConnectionString() });
  });

  it('should complete full audit cycle for outpatient claim', async () => {
    // 1. Create claim
    const claim = await app.inject({ method: 'POST', url: '/v1/claims', payload: { ... } });
    expect(claim.statusCode).toBe(201);

    // 2. Upload document
    const doc = await uploadTestDocument(app, claim.json().data.id, 'SHA_CLAIM_FORM_OP');
    expect(doc.statusCode).toBe(201);

    // 3. Trigger audit
    const audit = await app.inject({ method: 'POST', url: `/v1/claims/${claim.json().data.id}/audit` });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.decision).toBeDefined();
  });
});
```

### E2E Tests (Playwright)

```typescript
// tests/e2e/claim-lifecycle.spec.ts

test('Claims officer can create, audit, and fix a failed claim', async ({ page }) => {
  await page.goto('/login');
  await login(page, 'officer@hospital.ke', 'password');
  // 1. Create claim
  await page.click('[data-testid="new-claim"]');
  await fillClaimForm(page, { type: 'OUTPATIENT', ... });
  await page.click('[data-testid="save-claim"]');
  // 2. Upload documents
  await uploadDocument(page, 'test-data/claim-form-op.pdf', 'SHA_CLAIM_FORM_OP');
  // 3. Run audit
  await page.click('[data-testid="run-audit"]');
  await page.waitForSelector('[data-testid="audit-result"]');
  // 4. If failed, correct fields and re-audit
  // ...
});
```

### ML Service Benchmark Tests

```python
# packages/ml-service/tests/test_benchmarks.py

# Fixed set of 50 test documents with known expected outputs
# Run on every PR to track accuracy over time

def test_ocr_accuracy_typed_documents():
    results = process_benchmark_set("typed_docs/")
    assert results["word_error_rate"] < 0.15  # 15% max

def test_ocr_accuracy_handwritten():
    results = process_benchmark_set("handwritten_docs/")
    assert results["word_error_rate"] < 0.25  # 25% max

def test_doc_classifier_accuracy():
    results = classify_benchmark_set("classified_docs/")
    assert results["accuracy"] > 0.90  # 90% min

def test_signature_detection_recall():
    results = detect_signatures_benchmark("signed_docs/")
    assert results["recall"] > 0.85  # Don't miss real signatures
```

---

## 32. CONFIGURATION SCHEMA

All configuration via environment variables. The API validates all config at startup and fails fast with clear error messages.

```typescript
// packages/api/src/config.ts

import { z } from 'zod';

const configSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().default(8080),

  // Database
  DATABASE_URL: z.string().url(),
  DB_POOL_MIN: z.coerce.number().default(5),
  DB_POOL_MAX: z.coerce.number().default(20),

  // Storage
  STORAGE_PATH: z.string().default('/data'),

  // ML Service
  ML_SERVICE_URL: z.string().url().default('http://ml:8000'),
  ML_TIMEOUT_MS: z.coerce.number().default(60_000),

  // Rule Engine
  RULEPACK_DIR: z.string().default('/data/rulepacks'),

  // Auth
  KEY_PATH: z.string().default('/etc/claimflow/keys'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  REQUIRE_MFA: z.enum(['true', 'false']).default('true'),
  PASSWORD_MIN_LENGTH: z.coerce.number().default(12),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().default(5),
  LOCKOUT_DURATION_MINUTES: z.coerce.number().default(15),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().default(30),

  // Security
  RATE_LIMIT_RPM: z.coerce.number().default(100),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(50),
  MAX_PAGES_PER_DOCUMENT: z.coerce.number().default(50),
  MAX_CLAIMS_PER_BATCH: z.coerce.number().default(200),
  BATCH_CONCURRENCY: z.coerce.number().default(4),

  // OCR Thresholds
  CONF_THRESHOLD_HIGH: z.coerce.number().default(0.85),
  CONF_THRESHOLD_LOW: z.coerce.number().default(0.60),
  MANUAL_ENTRY_THRESHOLD: z.coerce.number().default(0.40),

  // Licensing
  LICENSE_TOKEN: z.string().optional(),

  // Sync
  CONTROL_PLANE_URL: z.string().url().optional(),
  SYNC_GOVERNANCE_MODE: z.enum(['METRICS_ONLY', 'DEIDENTIFIED', 'FULL_ANALYTICS']).default('METRICS_ONLY'),
  SYNC_INTERVAL_HOURS: z.coerce.number().default(6),

  // External Integrations
  AFYALINK_ENV: z.enum(['UAT', 'PRODUCTION']).default('UAT'),
  AFYALINK_CLIENT_ID: z.string().optional(),
  AFYALINK_CLIENT_SECRET: z.string().optional(),
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().default(5),
  CIRCUIT_BREAKER_RESET_MS: z.coerce.number().default(300_000),
  REGISTRY_CACHE_TTL_HOURS: z.coerce.number().default(24),

  // Observability
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Configuration validation failed:');
    result.error.issues.forEach(issue => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }
  return result.data;
}
```

---

## 33. INTERNATIONALIZATION (i18n)

### Strategy

- **Backend:** Rule messages and remediations stored as i18n JSON in rulepack (`message_i18n`, `remediation_i18n`). API resolves to user's preferred locale before returning.
- **Frontend:** next-intl with message files per locale. All UI strings externalized — zero hardcoded English in components.
- **PDF reports:** Generated with locale-specific templates.

### Supported Locales (v1)

| Code | Language | Coverage |
|------|----------|----------|
| `en` | English | 100% |
| `sw` | Kiswahili | 100% |

### Message File Structure

```json
// packages/shared/src/i18n/en.json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel",
    "delete": "Delete",
    "search": "Search",
    "loading": "Loading...",
    "noResults": "No results found"
  },
  "claims": {
    "title": "Claims",
    "newClaim": "New Claim",
    "status": {
      "DRAFT": "Draft",
      "PROCESSING": "Processing",
      "PASSED": "Passed",
      "FAILED": "Failed",
      "WARNING": "Warning"
    }
  },
  "audit": {
    "runAudit": "Run Audit",
    "fixReport": "Fix Report",
    "criticalIssues": "Critical Issues",
    "warnings": "Warnings",
    "passed": "Passed"
  }
}
```

```json
// packages/shared/src/i18n/sw.json
{
  "common": {
    "save": "Hifadhi",
    "cancel": "Ghairi",
    "delete": "Futa",
    "search": "Tafuta",
    "loading": "Inapakia...",
    "noResults": "Hakuna matokeo yaliyopatikana"
  },
  "claims": {
    "title": "Madai",
    "newClaim": "Dai Jipya",
    "status": {
      "DRAFT": "Rasimu",
      "PROCESSING": "Inachakatwa",
      "PASSED": "Imepita",
      "FAILED": "Imeshindwa",
      "WARNING": "Onyo"
    }
  },
  "audit": {
    "runAudit": "Fanya Ukaguzi",
    "fixReport": "Ripoti ya Marekebisho",
    "criticalIssues": "Matatizo Muhimu",
    "warnings": "Maonyo",
    "passed": "Imepita"
  }
}
```

---

## 34. SECURITY HARDENING

### Rate Limiting
- Per-user: 100 requests/minute (configurable via `RATE_LIMIT_RPM`)
- Per-IP (unauthenticated endpoints like /auth/login): 20 requests/minute
- Batch audit: 1 concurrent batch per user
- Implementation: in-memory rate limiter (fastify-rate-limit) with Redis-compatible interface for future scaling

### Input Validation
- All request bodies validated with Zod schemas before route handler executes.
- File uploads: MIME type verified against magic bytes (not just Content-Type header).
- String inputs: maximum length enforced (patient name: 200 chars, descriptions: 1000 chars, reason fields: 2000 chars).
- SQL injection: prevented by parameterized queries (never string interpolation).
- XSS in fix reports: Markdown rendered with sanitization (DOMPurify) before display.
- Path traversal: storage_path never constructed from user input; uses UUID-based paths only.

### Upload Validation
- Max file size per document: 50 MB
- Max total size per claim: 200 MB
- Max pages per document: 50
- Accepted MIME types: `application/pdf`, `image/jpeg`, `image/png`, `image/tiff`
- Virus scanning: ClamAV integration (optional, recommended for hospital environments)

### HTTP Security Headers
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; script-src 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
```

### Network Security
- API listens only on Docker internal network + mapped host port.
- ML service: internal network only (no host port mapping in production).
- PostgreSQL: internal network only.
- Web UI: served via nginx reverse proxy with HTTPS termination.

---

## 35. FAILURE CONDITIONS & ACCEPTANCE GATES

### Engineering Failure Conditions (block release if ANY are true)

| # | Condition | Severity |
|---|-----------|----------|
| F1 | An invalid claim can pass audit (false negative) | CRITICAL |
| F2 | OCR word error rate exceeds 20% on typed documents | CRITICAL |
| F3 | Audit pipeline latency exceeds 30 seconds for 20-page document | HIGH |
| F4 | PHI appears in plaintext in logs, metrics, or sync payload | CRITICAL |
| F5 | User from Tenant A can see data from Tenant B | CRITICAL |
| F6 | Audit without deterministic replay guarantee (same input ≠ same output) | CRITICAL |
| F7 | No OpenAPI contract validation on request handling | HIGH |
| F8 | No optimistic concurrency control (missing version + 409) | HIGH |
| F9 | Audit trail is not append-only (UPDATE/DELETE possible) | CRITICAL |
| F10 | ML service failure crashes the entire system (no degraded mode) | HIGH |
| F11 | No license enforcement for Pro-tier features | MEDIUM |
| F12 | Database backup has not been verified in last 30 days | HIGH |
| F13 | Any rule in the catalog lacks both PASS and FAIL test cases | HIGH |

### Acceptance Gate Checklist (pre-pilot)

- [ ] All 120 rules have unit tests with PASS + FAIL cases
- [ ] Integration test suite passes against real Postgres
- [ ] E2E test covers: create claim → upload docs → audit → view result
- [ ] Degraded mode tested: ML service stopped, manual audit works
- [ ] Backup + restore tested: full cycle completed successfully
- [ ] Setup.sh runs on clean Ubuntu 24.04 with Docker
- [ ] OCR benchmark meets accuracy targets on test document set
- [ ] Security: no SQL injection, no XSS, rate limiting works
- [ ] i18n: all UI strings available in both EN and SW
- [ ] Performance: p95 audit latency ≤ 20s on reference hardware

---

## 36. BUILD ORDER FOR CLAUDE CODE

Each step is a testable milestone. Do not proceed to step N+1 until step N passes its tests.

### Sprint 0: Foundation (Week 1)
1. **Monorepo scaffold** — pnpm workspace, tsconfig, shared package structure
2. **Database migrations** — all 14 migration files, run against local Postgres
3. **Shared types package** — all enums, interfaces, Zod schemas, error codes, state machine
4. **Config loader** — typed config with validation, fail-fast on missing required vars

### Sprint 1: Core Engine (Week 2)
5. **Rule engine core** — YAML rulepack loader, evaluator, fix report generator
6. **First 30 rules** — identity (15) + documentation (first 15), with full test coverage
7. **Rule engine tests** — every rule has PASS + FAIL + edge case tests

### Sprint 2: API Layer (Week 3)
8. **Fastify server setup** — plugins (auth stub, tenant, rate-limit, error-handler)
9. **Claims CRUD** — POST, GET list, GET detail, PATCH with optimistic concurrency
10. **State machine** — transitions with validation, audit trail logging
11. **Document upload** — multipart handling, LocalFileStore, checksum, page counting

### Sprint 3: ML + Pipeline (Week 4)
12. **ML service** — FastAPI with Tesseract OCR endpoint, basic doc classifier, quality check
13. **Audit pipeline orchestrator** — extract → rules → persist, partial failure handling
14. **Extraction endpoints** — page extraction results, field correction

### Sprint 4: Web UI (Week 5)
15. **Next.js setup** — app router, API client, auth context, i18n (next-intl)
16. **Claims dashboard** — list with filters, status badges, pagination
17. **Audit workspace** — split pane, document viewer, extraction editor, keyboard nav
18. **Dashboard analytics** — overview cards, charts (recharts), top failing rules

### Sprint 5: Completeness (Week 6)
19. **Remaining 90 rules** — clinical, authorization, financial, structural + tests
20. **Batch audit** — batch endpoint, job progress, UI "Audit All Pending"
21. **Fix report PDF** — Markdown → PDF generation, evidence pack ZIP export

### Sprint 6: Auth + Security (Week 7)
22. **Auth system** — JWT RS256, refresh rotation, TOTP MFA setup/verify
23. **RBAC** — permission middleware, role enforcement on all routes
24. **Security hardening** — rate limiting, input validation, upload validation, HTTP headers

### Sprint 7: Operations (Week 8)
25. **Sync agent** — rulepack download, metrics upload, license validation
26. **Docker Compose** — all Dockerfiles, compose file, health checks, resource limits
27. **Setup script** — first-run automation, key generation, seed data
28. **Backup scripts** — automated backup, restore, verification

### Sprint 8: Polish + Testing (Week 9)
29. **Integration tests** — full pipeline with testcontainers
30. **E2E tests** — Playwright for critical flows
31. **ML benchmarks** — accuracy tests against reference document set
32. **i18n completion** — all Swahili translations, locale switching
33. **Performance testing** — verify SLOs on reference hardware

---

## 37. FUTURE ROADMAP

### v1.5 (3 months post-launch)
- LayoutLMv3 integration for improved field extraction (if accuracy data supports it)
- Enhanced signature detection (ML-based, trained on corrections data)
- Facility benchmarking (anonymous comparisons via control plane)
- CSV/Excel export for claim lists and analytics

### v2 (6 months post-launch)
- FHIR Claim Bundle shadow validator (local, pre-submission)
- Assisted submission flow (human-confirmed, not automated)
- Eligibility API integration (real-time patient coverage check)
- Local LLM chatbot for fix guidance (Phi-3 or Llama 3, fully on-prem)
- MinIO object storage for multi-node deployment
- TrOCR handwriting recognition (with sufficient training data)

### v3 (12 months post-launch)
- Outcome feedback loop: SHA rejection reasons → rule category mapping → ML rejection-risk model
- Cross-facility analytics (control plane dashboard)
- Active learning pipeline with strict governance for model improvement
- Automated claim submission (fully automated for low-risk claims, human-confirmed for high-risk)
- National claims analytics for SHA/MOH stakeholders
- Integration with additional HMIS systems (beyond current adapter)

---

## END OF SPECIFICATION

**This document is the single source of truth for ClaimFlow implementation.**
**Version:** 4.0
**Last Updated:** March 2026
**Next Review:** After Sprint 0 completion

To begin implementation with Claude Code, start with Sprint 0, Step 1: Monorepo scaffold.

---

# PART 2: ADDENDUM A — CONTROL PLANE SPECIFICATION & PILOT HOSPITAL

---

# CLAIMFLOW — ADDENDUM A: CONTROL PLANE SPECIFICATION

**Version:** 4.0-A
**Date:** March 2026
**Depends On:** ClaimFlow Definitive Specification v4.0

---

## A1. PURPOSE

The ClaimFlow Control Plane is a centrally hosted web application that manages all deployed ClaimFlow hospital instances. It is the operational backbone for a multi-facility SaaS business: it distributes rulepacks, provisions licenses, collects anonymized metrics, enables benchmarking, and provides Aifya/ClaimFlow operators with a single view across all hospitals.

The control plane does NOT process claims or handle PHI. It only receives anonymized metrics per the hospital's governance mode.

---

## A2. CONTROL PLANE vs HOSPITAL INSTANCE

| Concern | Hospital Instance (On-Prem) | Control Plane (Cloud) |
|---------|----------------------------|----------------------|
| Claims processing | ✅ | ❌ |
| PHI storage | ✅ (encrypted) | ❌ NEVER |
| Rule engine execution | ✅ | ❌ |
| Rulepack authoring | ❌ | ✅ |
| License provisioning | ❌ (validates) | ✅ (issues) |
| Anonymized metrics | ✅ (sends) | ✅ (receives + displays) |
| User management | ✅ (hospital users) | ✅ (operator users) |
| Software updates | ✅ (receives) | ✅ (distributes) |

---

## A3. TECHNOLOGY STACK

| Layer | Technology | Justification |
|-------|-----------|---------------|
| API | TypeScript + Fastify (same as hospital) | Code sharing with hospital instance |
| Frontend | Next.js (TypeScript) | Same as hospital; shared component library |
| Database | PostgreSQL 17 (hosted) | Managed Postgres (Neon, Supabase, or Railway) |
| Hosting | Railway, Render, or Fly.io | Simple deployment for v1; move to dedicated infra later |
| Auth | Clerk or built-in JWT (same pattern as hospital) | Operator authentication |
| File Storage | S3-compatible (R2, S3, or Railway volumes) | Rulepack YAML files, ML model binaries |
| Monitoring | Built-in /metrics + hosted Grafana (optional) | |

---

## A4. CONTROL PLANE DATA MODEL

```sql
-- Operators (ClaimFlow/Aifya staff who manage the platform)
CREATE TABLE operators (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'operator',   -- 'super_admin', 'operator', 'viewer'
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenants (organizations — could be a hospital group or single hospital)
CREATE TABLE cp_tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    contact_email   TEXT,
    contact_phone   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Facilities (individual hospital instances)
CREATE TABLE cp_facilities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES cp_tenants(id),
    name            TEXT NOT NULL,
    sha_facility_code TEXT NOT NULL UNIQUE,
    mfl_code        TEXT,
    tier_level      TEXT NOT NULL,
    county          TEXT NOT NULL,
    sub_county      TEXT,
    facility_type   TEXT NOT NULL DEFAULT 'HOSPITAL',
    -- Licensing
    license_tier    TEXT NOT NULL DEFAULT 'FREE',       -- FREE, PRO
    license_expires_at TIMESTAMPTZ,
    -- Sync state
    last_sync_at    TIMESTAMPTZ,
    active_rulepack_version TEXT,
    active_software_version TEXT,
    sync_governance_mode TEXT NOT NULL DEFAULT 'METRICS_ONLY',
    -- Registration
    registration_code TEXT UNIQUE,                      -- One-time code for first sync
    registered_at   TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rulepacks (authored and stored centrally)
CREATE TABLE cp_rulepacks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_semver  TEXT NOT NULL UNIQUE,
    version_major   INTEGER NOT NULL,
    version_minor   INTEGER NOT NULL,
    version_patch   INTEGER NOT NULL,
    sha_policy_version TEXT,
    description     TEXT,
    changelog       TEXT,                               -- Markdown changelog
    rule_count      INTEGER NOT NULL,
    yaml_bundle_path TEXT NOT NULL,                     -- S3/R2 path to YAML ZIP
    checksum        TEXT NOT NULL,
    is_published    BOOLEAN NOT NULL DEFAULT false,     -- Available for distribution
    published_at    TIMESTAMPTZ,
    published_by    UUID REFERENCES operators(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Track which facilities have which rulepacks
CREATE TABLE cp_facility_rulepacks (
    facility_id     UUID NOT NULL REFERENCES cp_facilities(id),
    rulepack_version TEXT NOT NULL,
    downloaded_at   TIMESTAMPTZ,
    activated_at    TIMESTAMPTZ,
    is_current      BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY(facility_id, rulepack_version)
);

-- ML Models (centrally managed, distributed to facilities)
CREATE TABLE cp_ml_models (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name      TEXT NOT NULL,                     -- 'doc_classifier', 'paddleocr_custom', etc.
    version         TEXT NOT NULL,
    description     TEXT,
    file_path       TEXT NOT NULL,                     -- S3/R2 path
    file_size_bytes BIGINT NOT NULL,
    checksum        TEXT NOT NULL,
    requires_tier   TEXT NOT NULL DEFAULT 'FREE',      -- FREE or PRO
    is_published    BOOLEAN NOT NULL DEFAULT false,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(model_name, version)
);

-- License tokens (issued to facilities)
CREATE TABLE cp_licenses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     UUID NOT NULL REFERENCES cp_facilities(id),
    tier            TEXT NOT NULL,                     -- FREE, PRO
    feature_flags   JSONB NOT NULL DEFAULT '[]',
    token_hash      TEXT NOT NULL,                     -- SHA-256 of the signed JWT
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    issued_by       UUID REFERENCES operators(id)
);

-- Anonymized metrics (received from facilities)
CREATE TABLE cp_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     UUID NOT NULL REFERENCES cp_facilities(id),
    period_from     TIMESTAMPTZ NOT NULL,
    period_to       TIMESTAMPTZ NOT NULL,
    payload_json    JSONB NOT NULL,                    -- The full metrics payload
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aggregated metrics (pre-computed for dashboards)
CREATE TABLE cp_metrics_daily (
    facility_id     UUID NOT NULL REFERENCES cp_facilities(id),
    date            DATE NOT NULL,
    claims_created  INTEGER NOT NULL DEFAULT 0,
    claims_passed   INTEGER NOT NULL DEFAULT 0,
    claims_failed   INTEGER NOT NULL DEFAULT 0,
    claims_warning  INTEGER NOT NULL DEFAULT 0,
    avg_audit_latency_ms INTEGER,
    avg_ocr_confidence REAL,
    top_failing_rules JSONB,                           -- [{ruleId, count}]
    PRIMARY KEY(facility_id, date)
);

-- Software versions (Docker image tags distributed to facilities)
CREATE TABLE cp_software_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version         TEXT NOT NULL UNIQUE,               -- e.g. "1.3.0"
    changelog       TEXT,
    api_image_tag   TEXT NOT NULL,
    web_image_tag   TEXT NOT NULL,
    ml_image_tag    TEXT NOT NULL,
    min_rulepack_version TEXT,                          -- Compatibility constraint
    is_published    BOOLEAN NOT NULL DEFAULT false,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Audit log for operator actions
CREATE TABLE cp_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id     UUID REFERENCES operators(id),
    action          TEXT NOT NULL,
    target_type     TEXT,                               -- 'facility', 'rulepack', 'license', etc.
    target_id       UUID,
    detail_json     JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## A5. CONTROL PLANE API

### Authentication
Operator login uses the same JWT + TOTP pattern as the hospital instance. Operators are NOT hospital users — they are ClaimFlow/Aifya staff.

### Facility-Facing API (called by sync agents)

**POST /api/v1/sync/register** — First-time facility registration

```typescript
// Called by hospital sync agent with registration code from setup.sh
interface RegisterRequest {
  registrationCode: string;
  facilityInfo: {
    name: string;
    shaFacilityCode: string;
    mflCode?: string;
    tierLevel: string;
    county: string;
    softwareVersion: string;
  };
}

// Response: 200 OK
interface RegisterResponse {
  data: {
    facilityId: string;
    licenseToken: string;           // Signed JWT
    controlPlanePublicKey: string;  // For verifying future license tokens
    currentRulepackVersion: string;
    rulepackDownloadUrl: string;
  };
}
```

**POST /api/v1/sync/heartbeat** — Periodic sync (every 6 hours)

```typescript
// Called by hospital sync agent
// Authorization: Bearer <license_token>
interface HeartbeatRequest {
  facilityId: string;
  softwareVersion: string;
  activeRulepackVersion: string;
  governanceMode: 'METRICS_ONLY' | 'DEIDENTIFIED' | 'FULL_ANALYTICS';
  metrics?: MetricsPayload;         // Anonymized metrics (per governance mode)
}

// Response: 200 OK
interface HeartbeatResponse {
  data: {
    licenseValid: boolean;
    licenseRenewToken?: string;     // New token if approaching expiry
    updates: {
      rulepackAvailable?: {
        version: string;
        downloadUrl: string;
        checksum: string;
        changelog: string;
      };
      softwareAvailable?: {
        version: string;
        changelog: string;
        imageUrls: {
          api: string;
          web: string;
          ml: string;
        };
      };
      modelUpdates?: Array<{
        modelName: string;
        version: string;
        downloadUrl: string;
        checksum: string;
        requiresTier: string;
      }>;
    };
  };
}
```

**GET /api/v1/sync/rulepack/:version/download** — Download rulepack YAML bundle

**GET /api/v1/sync/model/:name/:version/download** — Download ML model file

### Operator-Facing API (web dashboard)

**Facilities Management**
- `GET /api/v1/facilities` — List all facilities with sync status, license tier, rulepack version
- `GET /api/v1/facilities/:id` — Facility detail with metrics history
- `POST /api/v1/facilities` — Register new facility (generates registration code)
- `PATCH /api/v1/facilities/:id` — Update facility (tier, governance mode, active status)

**Rulepack Management**
- `GET /api/v1/rulepacks` — List all rulepacks
- `POST /api/v1/rulepacks` — Upload new rulepack (YAML ZIP + metadata)
- `POST /api/v1/rulepacks/:version/publish` — Publish rulepack for distribution
- `GET /api/v1/rulepacks/:version/download` — Download for review
- `GET /api/v1/rulepacks/:version/diff/:otherVersion` — Diff two rulepacks

**License Management**
- `GET /api/v1/licenses` — List all active licenses
- `POST /api/v1/facilities/:id/license` — Issue/renew license
- `POST /api/v1/licenses/:id/revoke` — Revoke a license

**Analytics Dashboard**
- `GET /api/v1/analytics/overview` — Aggregate across all facilities
- `GET /api/v1/analytics/facilities/comparison` — Facility-by-facility comparison
- `GET /api/v1/analytics/rules/top-failures` — Top failing rules across all facilities
- `GET /api/v1/analytics/trends` — Time-series metrics (claims, pass rate, latency)

**Software Distribution**
- `GET /api/v1/software` — List versions
- `POST /api/v1/software` — Register new version
- `POST /api/v1/software/:version/publish` — Make available for distribution

---

## A6. CONTROL PLANE DASHBOARD (OPERATOR VIEW)

### Overview Page
- **Total facilities:** count by status (active, inactive, never synced)
- **Total claims across network:** today / this week / this month
- **Network pass rate:** aggregate, with per-facility breakdown
- **Facilities needing attention:** license expiring, not synced in >24h, on old rulepack
- **Latest rulepack:** version, published date, adoption rate across facilities

### Facility Detail Page
- Facility info (name, SHA code, tier, county, license)
- Sync history timeline (last 30 days)
- Metrics charts: claims/day, pass rate trend, top failing rules
- Current rulepack version vs latest available
- Current software version vs latest available
- Action buttons: renew license, push rulepack, revoke access

### Rulepack Editor (v1: upload + review)
- Upload YAML ZIP
- Validation: parse all YAML, check rule schema, verify logic_keys exist
- Diff viewer: compare new version against previous
- Publish button with confirmation
- Adoption tracker: which facilities have downloaded + activated

### Analytics Page
- Facility comparison table: sortable by pass rate, claim volume, avg latency
- Network-wide top 20 failing rules (which rules cause the most rejections across all hospitals)
- Trend charts: pass rate over time, claim volume over time
- Document quality: avg OCR confidence by document type across network
- Map view: facilities by county with color-coded pass rate (optional v1.5)

---

## A7. CONTROL PLANE MONOREPO ADDITION

```
claimflow/
├── packages/
│   ├── shared/                     # Already exists — shared types
│   ├── rule-engine/                # Already exists
│   ├── api/                        # Hospital API
│   ├── web/                        # Hospital web UI
│   ├── ml-service/                 # Hospital ML
│   ├── sync-agent/                 # Hospital sync agent
│   │
│   ├── control-plane-api/          # NEW — @claimflow/control-plane-api
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── config.ts
│   │   │   ├── routes/
│   │   │   │   ├── facilities.ts
│   │   │   │   ├── rulepacks.ts
│   │   │   │   ├── licenses.ts
│   │   │   │   ├── analytics.ts
│   │   │   │   ├── software.ts
│   │   │   │   ├── sync.ts         # Facility-facing sync endpoints
│   │   │   │   └── auth.ts
│   │   │   ├── services/
│   │   │   │   ├── facility-service.ts
│   │   │   │   ├── rulepack-service.ts
│   │   │   │   ├── license-service.ts
│   │   │   │   ├── metrics-service.ts
│   │   │   │   └── crypto.ts       # License token signing
│   │   │   └── db/
│   │   │       └── queries/
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── control-plane-web/          # NEW — @claimflow/control-plane-web
│       ├── src/
│       │   ├── app/
│       │   │   ├── dashboard/
│       │   │   ├── facilities/
│       │   │   ├── rulepacks/
│       │   │   ├── analytics/
│       │   │   └── settings/
│       │   ├── components/
│       │   └── lib/
│       ├── Dockerfile
│       └── package.json
│
├── docker/
│   ├── docker-compose.yml              # Hospital deployment
│   ├── docker-compose.control-plane.yml # NEW — Control plane deployment
│   └── ...
```

---

## A8. CONTROL PLANE DEPLOYMENT

```yaml
# docker/docker-compose.control-plane.yml

name: claimflow-control-plane

services:
  cp-postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: claimflow_cp
      POSTGRES_USER: claimflow_cp
      POSTGRES_PASSWORD: "${CP_DB_PASSWORD}"
    volumes:
      - cp_pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U claimflow_cp"]
      interval: 10s
      timeout: 5s
      retries: 5

  cp-api:
    build:
      context: ..
      dockerfile: packages/control-plane-api/Dockerfile
    restart: unless-stopped
    depends_on:
      cp-postgres:
        condition: service_healthy
    ports:
      - "8090:8090"
    environment:
      DATABASE_URL: "postgres://claimflow_cp:${CP_DB_PASSWORD}@cp-postgres:5432/claimflow_cp"
      JWT_PRIVATE_KEY_PATH: /keys/cp-jwt-private.pem
      JWT_PUBLIC_KEY_PATH: /keys/cp-jwt-public.pem
      LICENSE_SIGNING_KEY_PATH: /keys/license-signing-private.pem
      STORAGE_PROVIDER: "local"       # or "s3"
      STORAGE_PATH: /data
      PORT: 8090
    volumes:
      - cp_data:/data
      - cp_keys:/keys:ro

  cp-web:
    build:
      context: ..
      dockerfile: packages/control-plane-web/Dockerfile
    restart: unless-stopped
    depends_on:
      - cp-api
    ports:
      - "3090:3000"
    environment:
      NEXT_PUBLIC_API_URL: "http://cp-api:8090"

volumes:
  cp_pg_data:
  cp_data:
  cp_keys:
```

For production deployment: Railway or Fly.io single-command deploy, managed Postgres (Neon/Supabase), R2/S3 for file storage.

---

## A9. LICENSE SIGNING FLOW

```
┌──────────────┐                    ┌──────────────────┐
│  Control     │   1. Operator      │                  │
│  Plane       │   issues license   │    Hospital      │
│  (Cloud)     │ ──────────────────►│    Instance      │
│              │   Signed JWT with  │    (On-Prem)     │
│  Holds:      │   {tier, facility, │                  │
│  - Private   │    features, exp}  │    Holds:        │
│    signing   │                    │    - Public key   │
│    key       │   2. Sync agent    │      (embedded)  │
│              │◄──────────────────│                  │
│              │   heartbeat +      │    Validates     │
│              │   metrics          │    token locally  │
│              │                    │    (no phone-home │
│              │   3. Renewed token │     needed)      │
│              │──────────────────►│                  │
└──────────────┘                    └──────────────────┘
```

The license public key is embedded in the hospital's API Docker image and can also be updated via sync. License validation is entirely local — the hospital never needs to contact the control plane to verify its license. Sync is for renewal and metrics only.

---

## A10. BUILD ORDER (CONTROL PLANE)

This runs in parallel with the hospital instance build, starting at Sprint 4.

| Sprint | Step | Deliverable |
|--------|------|-------------|
| Sprint 4 | CP-1 | Control plane DB schema + migrations |
| Sprint 4 | CP-2 | Facility registration + license signing |
| Sprint 5 | CP-3 | Sync endpoints (heartbeat, rulepack download) |
| Sprint 5 | CP-4 | Operator auth + basic facility management UI |
| Sprint 6 | CP-5 | Rulepack upload + publish + diff viewer |
| Sprint 6 | CP-6 | Metrics ingestion + daily aggregation |
| Sprint 7 | CP-7 | Analytics dashboard (overview, facility comparison, top failures) |
| Sprint 7 | CP-8 | Software version management + distribution |
| Sprint 8 | CP-9 | Deploy to Railway/Fly.io + integration test with hospital sync agent |

---

# ADDENDUM B: PILOT HOSPITAL CONFIGURATION

## Mary Help of the Sick Mission Hospital — Facility Profile

| Field | Value |
|-------|-------|
| Facility Name | Mary Help of the Sick Mission Hospital |
| Location | Thika Town, Kiambu County |
| Sub-County | Juja |
| Facility Type | Faith-Based (Catholic, Archdiocese of Nairobi) |
| KMPDC Level | Level 4 |
| SHA Tier | LEVEL_4 (to be confirmed against Facility Registry) |
| Services | General medical/surgical, Mother and Child Center, maternity, outpatient, inpatient |
| Existing Aifya Relationship | Confirmed client |

### Priority Claim Types for Pilot

Based on a Level 4 faith-based hospital with a Mother and Child Center:

1. **OUTPATIENT** — highest volume, simplest claims, best for initial validation
2. **MATERNITY** — strong focus given the new Mother and Child Center; maternity claims have specific SHA documentation requirements (delivery record, birth notification, ANC card)
3. **INPATIENT** — standard medical/surgical inpatient admissions
4. **SURGICAL** — for inpatient surgical cases

### Priority Rules for Pilot (First 30 to Perfect)

Focus on the rules most likely to catch real rejections at a Level 4 hospital:

**Identity (high priority — these cause immediate SHA rejection):**
IDN-001, IDN-002, IDN-003, IDN-005, IDN-008, IDN-009, IDN-013

**Documentation (the most common rejection reasons):**
DOC-001, DOC-002, DOC-003, DOC-004, DOC-007, DOC-009, DOC-014, DOC-020, DOC-030, DOC-031

**Clinical (ICD-11 coding errors are extremely common):**
CLN-001, CLN-002, CLN-005

**Financial (tariff mismatches):**
FIN-001, FIN-002, FIN-007

**Structural (basic claim integrity):**
STR-001, STR-002, STR-003, STR-006

**Authorization:**
AUT-001, AUT-007, AUT-009

### SHA Claim Form Field Mapping (to be refined with actual forms)

When Jesse uploads the actual SHA claim forms, we need to map these extracted fields to bounding box regions:

**Common fields across all SHA claim forms:**
- `patient_name` — Patient full name
- `patient_sha_id` — SHA/CR number
- `patient_national_id` — National ID number
- `patient_dob` — Date of birth
- `patient_gender` — Gender
- `facility_name` — Facility name (pre-printed or stamped)
- `facility_sha_code` — Facility SHA code
- `admission_date` — Date of admission/visit
- `discharge_date` — Date of discharge (inpatient/maternity)
- `primary_diagnosis` — Primary diagnosis text
- `primary_icd_code` — ICD-11 code
- `physician_name` — Treating physician name
- `physician_signature_present` — Boolean: signature detected
- `physician_stamp_present` — Boolean: stamp/seal detected
- `claim_form_date` — Date on the form
- `total_amount` — Total claim amount

**Maternity-specific fields:**
- `gestational_age` — Gestational age at admission
- `delivery_type` — Normal/Caesarean/Assisted
- `baby_weight` — Birth weight
- `baby_gender` — Baby gender
- `apgar_score` — Apgar score at 1 and 5 minutes
- `delivery_date` — Date of delivery
- `mother_name` — Mother's name (should match patient_name)

### Initial Facility Seed Data

```sql
-- For setup.sh to pre-populate
INSERT INTO tenants (id, name, slug) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Mary Help Hospital', 'mary-help');

INSERT INTO facilities (id, tenant_id, name, sha_facility_code, tier_level, license_status, county, sub_county, facility_type) VALUES
    ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
     'Mary Help of the Sick Mission Hospital',
     'TBD-FROM-FACILITY-REGISTRY',  -- To be confirmed from fr.kenya-hie.health
     'LEVEL_4', 'ACTIVE', 'KIAMBU', 'JUJA', 'HOSPITAL');
```

### Next Step: SHA Claim Form Upload

Jesse to upload the following sample documents (today):
1. SHA Outpatient Claim Form (blank or filled) — PDF or image
2. SHA Inpatient Claim Form — PDF or image
3. SHA Maternity Claim Form — PDF or image
4. Any other supporting documents commonly submitted

These will be used to:
- Build OCR field extraction templates (bounding box mapping)
- Train the document classifier
- Create realistic test data for the rule engine
- Design the audit workspace layout around actual form structure

---

# PART 3: ADDENDUM C — SHA FORM FIELD MAPPING & TARIFF INTEGRATION

---

# CLAIMFLOW — ADDENDUM C: SHA FORM FIELD MAPPING & TARIFF INTEGRATION

## Based on Actual Documents Received March 5, 2026

---

## C1. DOCUMENTS RECEIVED AND ANALYZED

| # | Document | Type | Key Findings |
|---|----------|------|-------------|
| 1 | CamScanner SHA Portal Screenshot | SHA Provider Portal (portal.sha.go.ke) | Confirms Mary Help facility details: LEVEL 4, KIAMBU, Registration Number 000210, **Facility Registry: FID-22-106718-4** |
| 2 | SHA Claim Form — Jordan Hospital | Filled SHA Claim Form (3 pages) + Lab Results (2 pages) | Real-world completed claim with all fields visible. ICD-11 code GB61, inpatient, chronic kidney disease case |
| 3 | SHI Tariffs to Benefit Package (Original) | SHA Benefit Package Tariff Document (31 pages) | Complete tariff schedule including all benefit packages, access rules, limits, exclusions, and full surgical annex |
| 4 | Legal Notice No. 56 — March 2025 Tariffs | Official Kenya Gazette Legal Notice (40 pages) | **Updated/current tariff schedule** revoking LN 146 of 2024. Signed by Cabinet Secretary for Health, Feb 28, 2025. Contains revised tariffs and updated surgical annex |

---

## C2. MARY HELP OF THE SICK — CONFIRMED FACILITY DETAILS

Extracted directly from the SHA Provider Portal screenshot:

| Field | Value | Source |
|-------|-------|--------|
| **Facility Name** | MARY HELP OF THE SICK MISSION HOSPITAL | Portal header |
| **Level** | LEVEL 4 | Portal header |
| **County** | KIAMBU | Portal header |
| **Registration Number** | 000210 | Portal header |
| **Facility Registry Code** | **FID-22-106718-4** | Portal header |
| **Portal Version** | FE v2.4.20 | Portal header |
| **Portal URL** | portal.sha.go.ke/edi/claims | URL bar |
| **Logged-in User** | PATRICIA MUGECHI | Portal header |
| **HMIS System** | Q-Afya (tab visible in browser) | Browser tabs |

**Critical for implementation:** The Facility Registry code `FID-22-106718-4` is the exact identifier used in FHIR Organization resources and AfyaLink bundle submissions. This should be pre-configured in the facility seed data.

**Portal sections visible:** Dashboards, Eligibility, Claims, PHC Claims, Prescriptions, Preauthorizations, Authorizations, Pricelist, Invoices, Payments, Reports. The Claims page shows tabs for: Pending, Pending Discharge, Pending Resubmission, Missing Documents (NEW), Sent, Time Barred, Closed, All.

The "Missing Documents" tab with a "NEW" badge is strong validation of ClaimFlow's value proposition — SHA is actively flagging claims with missing documentation.

---

## C3. SHA CLAIM FORM FIELD MAPPING (from Jordan Hospital sample)

This is the actual SHA claim form under the Social Health Insurance Act, 2023 / Social Health Insurance Regulations, 2024. The form is titled **"CLAIMS"** and has the following structure:

### Form Header
- Title: "REPUBLIC OF KENYA / SOCIAL HEALTH INSURANCE ACT, 2023 / SOCIAL HEALTH INSURANCE REGULATIONS, 2024 / CLAIMS"
- Filing reminders box (4 reminders about capital letters, 7-day deadline, mandatory fields, false information warning)
- **CLAIM NO:** field (top right)

### PART I — HEALTH CARE PROVIDERS DETAILS

| Field Key | Form Label | OCR Zone | Data Type | Example Value |
|-----------|-----------|----------|-----------|---------------|
| `provider_id` | 1. Health Provider Identification Number | Top of Part I | Numeric string | "6660698" |
| `provider_name` | 2. Name of Health Care Provider/Facility | Below provider ID | Free text | "JORDAN HOSPITAL" |

### PART II — PATIENT DETAILS

| Field Key | Form Label | OCR Zone | Data Type | Example Value |
|-----------|-----------|----------|-----------|---------------|
| `patient_last_name` | Patient's Full Name: Last Name | Part II top | Free text | "MWANGANGI" |
| `patient_first_name` | Patient's Full Name: First Name | Below last name | Free text | "JULIUS" |
| `patient_middle_name` | Patient's Full Name: Middle Name | Below first name | Free text | "KITHUVA" |
| `sha_number` | 3. Social Health Authority Number | Below name fields | Alphanumeric | (not visible in sample — may be blank or under stamp) |
| `residence` | 4. Residence | Below SHA number | Free text | (obscured by hospital stamp) |
| `other_insurance` | 5. Do you have another Health Insurance | Checkbox + text | Boolean + text | "✗" (marked) |
| `relationship_to_principal` | 6. Relationship to the Principal | Below insurance | Free text | (not filled in sample) |

### PART III — PATIENT VISIT DETAILS

| Field Key | Form Label | OCR Zone | Data Type | Example Value |
|-----------|-----------|----------|-----------|---------------|
| `referral_info` | 7. Referral Information | Part III top | Free text | — |
| `was_referred` | Was the patient referred? | Radio/checkbox | Boolean | "NO" (checked) |
| `referring_facility` | Name of Referral Institution | Conditional | Free text | "N/A" |
| `referral_reason` | Reason/s for referral | Conditional | Free text | — |
| `visit_type` | Visit type | Checkbox group | Enum | "☐Inpatient ☐Outpatient ☐Day-care" |
| `accommodation_type` | Type of Accommodation | Free text field | Text | "RENAL" (from sample: Female Medical, Male Medical, etc.) |
| `visit_date` | Visit/Admission Date | Date field | Date | "4/01/2025" |
| `op_ip_number` | OP/IP No. | Text field | String | "600/2024" |
| `new_or_return` | New/Return Visit | Checkbox | Enum | — |
| `discharge_date` | Discharge Date | Date field | Date | "4/01/2025" |
| `physician_name` | Rendering Physician Name | Text field | Text | "DR. JULIET AKOTH" |
| `physician_reg_no` | Registration No | Text field | String | "A 7816" |

### PATIENT DISPOSITION (Section 9)

| Field Key | Form Label | Data Type | Example |
|-----------|-----------|-----------|---------|
| `disposition` | Patient Disposition upon discharge | Checkbox group | "Improved ☑" |

Options: Improved, Recovered, Leave Against/Discharged Against Medical Advice, Absconded, Died

### DIAGNOSIS SECTION (Sections 11-12)

| Field Key | Form Label | Data Type | Example |
|-----------|-----------|-----------|---------|
| `admission_diagnosis` | 11. Admission Diagnosis/es | Free text | "CHRONIC KIDNEY DISEASE" |
| `discharge_diagnosis` | 12. Discharge Diagnosis/es: Diagnosis | Free text | "CHRONIC KIDNEY DISEASE" |
| `icd_code` | ICD-11 Code/s | Code | "GB61" |
| `related_procedure` | Related Procedure/s | Free text | — |
| `procedure_date` | Date of Procedure | Date | — |

### SHA HEALTH BENEFITS TABLE (Section 14)

This is the critical claims line-item table:

| Column | Data Type | Example |
|--------|-----------|---------|
| Date of Admission | Date | "4/1/25" |
| Date of Discharge | Date | "4/1/25" |
| Case Code | Numeric | "03" |
| ICD 11/Procedure Code | Code | "GB61" |
| Description | Free text | "END STAGE RENAL DISEASE" |
| Preauth No. | String | (blank) |
| Bill Amount | Currency | (blank) |
| Claim Amount | Currency (KES) | "19,650" |

**Note:** "For outpatient services, Date of service is the Date of admission"

### PATIENT DECLARATION (Section D)

| Field Key | Data Type | Example |
|-----------|-----------|---------|
| `patient_name_declaration` | Free text | "JULIUS KITHUVA" |
| `patient_signature` | Signature image | ✅ Present |
| `patient_signature_date` | Date | "4/01/2025" |

### HOSPITAL DECLARATION (Section E)

| Field Key | Data Type | Example |
|-----------|-----------|---------|
| `hospital_approved_amount` | Currency | "10,650" |
| `hospital_signature` | Signature image | ✅ Present (with text "Beth") |
| `hospital_signature_date` | Date | "4/01/2025" |

### FOR OFFICIAL USE ONLY (Section F)

| Field Key | Data Type |
|-----------|-----------|
| `receiving_officer_name` | Free text |
| `receiving_officer_date` | Date |

### Fraud Warning Footer
"Any person/institution who/knowingly files a statement of request or claim containing any misrepresentation or false, incomplete, or misleading information may be guilty of medical fraud punishable under law."

---

## C4. LAB RESULTS FORMAT (Jordan Hospital Sample)

Two lab result pages were included, both from The Jordan Hospital Ltd:

### Full Hemogram (FHG) Page
- **Header:** Facility name, outpatient number, patient name, age, examination type, date, time
- **Table format:** Test abbreviation | Input value | Normal values range | Flag (H/L/N)
- **Tests included:** GRAN, GRAN%, HCT, HGB, LPCR, LYM, LYM%, MCH, MCHC, MCV, MDD, MDD%, MPV, PCT, PDW, PLT, RBC, RDW, RDW%, WBC
- **Footer:** "Results Posted by (Lab Specialist's Name): FAITH KATILE KYANIA"
- **Stamp:** Hospital circular stamp visible

### Renal Function Test (U/E/CR) Page
- **Header:** Same format as FHG
- **Examination type:** U/E/CR (RENAL FUNCTION TEST)
- **Tests:** CL-, CREATININE, EGFR BY CKD-EPI FORMULA, K+, NA+, UREA
- **Includes:** Flag column with interpretation (e.g., "KIDNEY FAILURE" flag for low eGFR)
- **Footer:** Lab specialist name + Doctor's name with signature and stamp

**Key observation for OCR:** Lab results are **digitally generated** (not handwritten) with clear structured tables. The STRUCTURED_EXTRACT processing route is correct for these — tabular OCR with known column positions will work well.

---

## C5. TARIFF DATA INTEGRATION

### Which Tariff Document to Use

The **Legal Notice No. 56 (March 2025)** explicitly revokes Legal Notice No. 146 of 2024 and represents the current official tariff schedule. The earlier "SHI Tariffs to Benefit Package" document is the predecessor. For ClaimFlow, we must use the Legal Notice No. 56 tariffs.

### Key Tariff Rates for Mary Help Hospital (Level 4)

| Benefit Package | Tariff (KES) | Access Rules |
|----------------|-------------|--------------|
| **Outpatient (PHC)** | 900/person/year (capitation) | Level 2-4 primary care |
| **SHIF Outpatient Labs (Diabetes)** | 4,300 | Level 4-6, once/year |
| **SHIF Outpatient Labs (Hypertension)** | 2,850 | Level 4-6, once/year |
| **Medical Inpatient (Level 4)** | **3,360/day** | Up to 180 days/household/year |
| **Maternity — Normal Delivery** | **10,000** (package) | Level 2-6 |
| **Maternity — Caesarean Section** | **30,000** (package) | Level 2-6 |
| **Maternity — Anti-D Serum** | **6,000** | Rhesus-negative mothers |
| **Hemodialysis** | **10,650/session** | 2 sessions/week |
| **Peritoneal Dialysis** | 85,200/month | 12 monthly sessions |
| **Critical Illness** | **28,000/diem** | Up to 12 days, then authorization |
| **Surgical — Minor** | Per annex | 3 minor/household/year |
| **Surgical — Major** | Per annex | 2 major/household/year |
| **Surgical — Specialized** | Per annex | 1 specialized/household/year |
| **MRI** | 11,000 | 2/household/year |
| **CT Scan** | 6,900 | 2/household/year |
| **Rehabilitation (DSA)** | 67,200 | — |

### Validation Rule Implications

From the Jordan Hospital sample: The claim is for **End Stage Renal Disease** (GB61), with a claim amount of **KES 19,650**. This is approximately **2 hemodialysis sessions** at KES 10,650/session (totaling 21,300). The claimed 19,650 is below tariff maximum — this claim would PASS financial validation rule FIN-002.

The hospital declaration shows an approved amount of **KES 10,650** (exactly 1 session), while the claim line shows 19,650. This discrepancy between claim amount and hospital-approved amount is something ClaimFlow should flag as a WARNING (new rule: FIN-021 — claim amount differs from hospital-approved amount).

### Surgical Tariff Data Volume

The Legal Notice No. 56 surgical annex contains **549 procedures** across these specialties:
Cardiology, Cardiothoracic/Vascular, ENT, General Surgery, Hematooncology, Interventional Radiology, Maxillofacial, Neurosurgery, Obstetrics/Gynaecology, Ophthalmic, Orthopaedic, Paediatric Surgery, Plastic Surgery, Urological Surgery.

Each procedure has: Specialty, Procedure name, Complexity (Minor/Major/Specialized), Tariff (KES).

This needs to be loaded into the `tariffs` and `sha_service_codes` tables. The CSV extraction from this PDF should be a Sprint 0 task.

---

## C6. UPDATED FINDINGS FOR SPECIFICATION

### Finding 1: Add `provider_id` field to claims

The SHA form uses a **Health Provider Identification Number** (e.g., "6660698") that is separate from the Facility Registry code (FID-xx-xxxxxx-x). The claims table needs a field for this HMIS/SHA provider ID.

**Action:** Add `sha_provider_id TEXT` to the `facilities` table.

### Finding 2: Case Code field on claim lines

The SHA benefits table includes a **Case Code** column (e.g., "03") that we didn't include in our claim_lines table. This appears to be a SHA-specific case classification.

**Action:** Add `case_code TEXT` to the `claim_lines` table.

### Finding 3: Hospital-Approved Amount vs Claim Amount

The form has separate "Bill Amount" and "Claim Amount" columns, plus a hospital declaration section with a separate approved amount. ClaimFlow should capture both and validate consistency.

**Action:** Add `bill_amount NUMERIC(12,2)` to `claim_lines`. Add `hospital_approved_total NUMERIC(12,2)` to `claims`.

### Finding 4: Patient Disposition field

The form captures patient disposition on discharge (Improved, Recovered, DAMA, Absconded, Died). This is clinically important and affects certain rules.

**Action:** Add `patient_disposition TEXT` to `claims` with enum: IMPROVED, RECOVERED, DAMA, ABSCONDED, DIED.

### Finding 5: Accommodation Type field

The form captures accommodation type (Female Medical, Male Medical, Female Surgical, Male Surgical, NBU, Psychiatric Unit, Burns, ICU, HDU, NICU, Isolation, Maternity, Renal).

**Action:** Add `accommodation_type TEXT` to `claims`.

### Finding 6: New Rule — Hospital Approved vs Claim Amount mismatch

**Rule FIN-021:** `verify_hospital_approved_matches_claim` — MAJOR severity. If hospital_approved_total differs from sum of claim line amounts by more than 5%, flag as warning.

### Finding 7: Tariff CSV extraction is Sprint 0 prerequisite

The 549 surgical procedures + benefit package rates need to be extracted into CSV and loaded into the database. This is reference data that the financial rules depend on.

**Action:** Extract tariff data from Legal Notice No. 56 PDF into `reference-data/sha-tariffs-march-2025.csv` and `reference-data/sha-surgical-procedures.csv`.

### Finding 8: Form layout is consistent and structured

The SHA claim form is a standardized printed form with clearly delineated sections, boxes, and labels. This is excellent for OCR — the form layout is consistent across hospitals (Jordan Hospital sample will match Mary Help Hospital forms since it's the same SHA form). Field positions can be mapped using template matching.

---

## C7. UPDATED FACILITY SEED DATA

```sql
INSERT INTO tenants (id, name, slug) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Mary Help Hospital', 'mary-help');

INSERT INTO facilities (
    id, tenant_id, name, sha_facility_code, sha_provider_id,
    mfl_code, tier_level, license_status, county, sub_county, facility_type
) VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'Mary Help of the Sick Mission Hospital',
    'FID-22-106718-4',          -- Confirmed from SHA Portal
    '000210',                    -- Registration Number from portal
    NULL,                        -- MFL code to be confirmed
    'LEVEL_4',                   -- Confirmed from SHA Portal
    'ACTIVE',
    'KIAMBU',                    -- Confirmed from SHA Portal
    'JUJA',
    'HOSPITAL'
);
```

---

# PART 4: EXPERT PANEL REVIEW (47 Recommendations)

---

# ClaimFlow Specification Review
## Expert Panel Assessment & Recommendations for Claude Code Implementation

**Review Panel Composition:**
- 7 Domain Experts (Health Informatics, FHIR/HL7, Kenya SHA Regulatory, Insurance Claims Processing, Medical Document Intelligence, Healthcare Security/Compliance, On-Premise Infrastructure)
- 3 Application Architects/Engineers (Distributed Systems, ML Systems, Developer Experience/DX)

**Specification Version Reviewed:** v1→v3 Consolidated
**Date:** March 2026

---

## VERDICT: Strong Foundation, 47 Actionable Recommendations

The specification is architecturally sound in its core thesis — a deterministic, on-prem, pre-submission audit layer. The micro-kernel approach and offline-first philosophy are correct for Kenyan hospital environments. However, the spec has significant gaps that would cause implementation failures if not addressed before Claude Code begins generating services. Below are the findings organized by severity.

---

## CRITICAL (Must Fix Before Implementation)

### 1. Go + Fiber Is Wrong for This System

**Problem:** The spec prescribes Go (Fiber) for API services and the Rule Engine. Go is excellent for network-heavy microservices but is a poor choice for a v1 product built by a small team against a complex domain. The rule engine needs rapid iteration on ~120 rules that will change frequently with SHA policy updates. Go's verbosity, lack of generics maturity for rule DSLs, and compile-deploy cycle will slow you down enormously.

**Recommendation:** Use **TypeScript (Node.js) with Fastify or Hono** for all API services, and a TypeScript-based rule engine. Reasons:
- Single language across frontend (Next.js) and backend — critical for a small team using Claude Code
- TypeScript's type system handles complex rule logic elegantly with union types and discriminated unions
- Claude Code generates TypeScript significantly better than Go
- npm ecosystem has mature libraries for FHIR validation, PDF processing, queue management
- You can always rewrite hot paths in Go later if profiling demands it (it won't in v1)

**Alternative if Go is non-negotiable:** Keep Go only for the Ingestion Service (simple CRUD + file upload), but move the Rule Engine to TypeScript where rule expressiveness matters most.

### 2. Four ML Models on an 8-CPU Hospital Server Is Unrealistic

**Problem:** The spec requires TrOCR, LayoutLMv3, Donut, AND YOLOv8 running concurrently on a machine with 8 CPUs and 32GB RAM. These models collectively need ~12-16GB RAM just for inference, leaving almost nothing for PostgreSQL, RabbitMQ, MinIO, the application services, and the OS. There's no GPU specified.

**Recommendation:**
- **v1:** Use a single, lighter pipeline — **Tesseract 5 + PaddleOCR** for OCR (works on CPU, ~500MB RAM), a simple CNN classifier for document type (train on your own forms, <100MB), and basic image processing for signature detection (contour analysis, no YOLO needed for detecting ink-on-paper signatures)
- **v1.5:** Add LayoutLMv3 only if Tesseract extraction accuracy is insufficient after tuning
- **v2+:** Introduce TrOCR for handwriting only when you have sufficient training data from the corrections pipeline
- Raise minimum server spec to **16 CPU / 64GB RAM / dedicated GPU (optional)** or offer a cloud-inference tier for Pro subscribers

### 3. No API Contract Definitions

**Problem:** The spec lists endpoints (POST /v1/claims, etc.) but provides zero request/response schemas, no error codes, no pagination strategy, no versioning contract. Claude Code cannot generate correct services without these.

**Recommendation:** Define OpenAPI 3.1 contracts for every endpoint before implementation. At minimum, specify:
- Request body JSON schemas with required/optional fields
- Response envelope structure (standardize on `{ data, meta, errors }`)
- Error code taxonomy (4xx client errors, 5xx system errors, custom domain codes like `RULE_HARD_STOP`)
- Pagination: cursor-based (not offset) for claims listing
- Idempotency keys for POST operations (critical — hospital networks are unreliable, requests will be retried)

### 4. Database Schema Is Dangerously Incomplete

**Problem:** The schema shows ~6 tables with partial columns. Critical entities are missing entirely.

**Recommendation:** Add these tables/columns before implementation:
- `facilities` — facility_id, name, sha_facility_code, license_status, tier_level
- `users` — id, tenant_id, role, email, password_hash, totp_secret, last_login
- `rulepacks` — id, version, sha_policy_version, activated_at, checksum
- `rulepack_rules` — rulepack_id, rule_id, category, severity, logic_key, params_json
- `audit_sessions` — id, claim_id, user_id, started_at, completed_at, decision, rulepack_version
- `corrections` — id, extracted_field_id, original_value, corrected_value, corrected_by, used_for_training
- `sync_events` — id, direction (up/down), payload_type, status, attempted_at, completed_at
- Add `version` column to `claims` for optimistic concurrency control
- Add `mime_type` and `page_count` to `documents`
- Add `bounding_box_json` to `extracted_fields`

### 5. No FHIR Resource Mapping

**Problem:** The spec mentions FHIR bundle validation and SHA/AfyaLink integration but never defines which FHIR resources map to which ClaimFlow entities. Without this, the Shadow Proxy (Section 25) is unimplementable.

**Recommendation:** Define explicit mappings:
- `Claim` → ClaimFlow claim record
- `Patient` → SHA client registry lookup
- `Encounter` → admission/visit context
- `Practitioner` → physician identity + signature validation
- `Organization` → facility identity
- `DocumentReference` → uploaded supporting documents
- `ClaimResponse` → audit result (internal, pre-submission)
- Specify which FHIR version (R4 is standard for SHA/AfyaLink)
- Define the exact FHIR Bundle structure SHA expects

---

## HIGH PRIORITY (Fix During Sprint 0)

### 6. Keycloak Is Overkill for On-Prem Hospital Deployment

**Problem:** Keycloak is a 1.5GB+ Java application requiring its own database. On an 8-CPU server already running PostgreSQL, RabbitMQ, MinIO, ML services, and the application — Keycloak will consume 512MB-1GB RAM doing very little.

**Recommendation:** Build a lightweight auth service directly into the API layer:
- JWT issuance/validation with RS256
- TOTP (use `otplib` in TypeScript or `pquerna/otp` in Go)
- RBAC stored in PostgreSQL
- Session management with refresh token rotation
- This is ~500 lines of code, not a separate Java application

### 7. RabbitMQ Can Be Replaced with PostgreSQL-Native Queuing

**Problem:** RabbitMQ adds another stateful service to manage, monitor, backup, and troubleshoot in hospital environments where IT support is minimal.

**Recommendation:** Use **PostgreSQL LISTEN/NOTIFY + the outbox pattern you already spec** with a lightweight worker process. For v1 throughput (a hospital processes maybe 50-200 claims/day), PostgreSQL-backed queuing is more than sufficient. Libraries like `graphile-worker` (TypeScript) or `pgqueue` provide exactly this. Benefits:
- One fewer service to deploy, monitor, and backup
- Transactional outbox becomes trivial (it's all in the same database)
- Simpler disaster recovery (one backup covers everything)

### 8. MinIO May Be Unnecessary for v1

**Problem:** Document storage via MinIO adds deployment complexity. Hospitals process perhaps 50-200 claims/day with ~20 pages each. That's ~1-4GB/day of documents.

**Recommendation:** For v1, store documents directly on the local filesystem with a thin abstraction layer. Use a `storage` interface so you can swap to MinIO/S3 later:
```
interface DocumentStore {
  put(claimId, docId, buffer): Promise<string>  // returns path
  get(path): Promise<Buffer>
  delete(path): Promise<void>
}
```
Implement `LocalFileStore` for v1, `MinioStore` for v2 when multi-node deployments arrive.

### 9. Missing Claim Lifecycle State Machine

**Problem:** The spec shows `status` on the claims table but never defines the valid states or transitions. This is the most critical business logic in the system.

**Recommendation:** Define explicitly:
```
DRAFT → DOCUMENTS_UPLOADED → PROCESSING → AUDIT_COMPLETE → 
  ├── PASSED → READY_FOR_SUBMISSION → SUBMITTED
  ├── FAILED → CORRECTIONS_IN_PROGRESS → DOCUMENTS_UPLOADED (re-audit)
  └── WARNING → OFFICER_REVIEW → PASSED / FAILED
```
Each transition should be an event stored in `audit_trail`. Invalid transitions must be rejected.

### 10. No Concurrent Editing / Locking Strategy

**Problem:** Multiple claims officers may work on the same claim. The spec has no concurrency control.

**Recommendation:** Implement optimistic concurrency with version numbers. When a user loads a claim, they receive its `version`. When they submit changes, the API checks `WHERE version = expected_version`. On conflict, return 409 with the current state. For the audit workspace, add advisory locks during active editing sessions.

### 11. OCR Confidence Thresholds Not Defined

**Problem:** The spec says "low confidence words highlighted" but never defines what "low" means, nor what happens when entire documents have low confidence.

**Recommendation:** Define three tiers:
- **HIGH** (>0.85): Auto-accepted, no highlight
- **MEDIUM** (0.60-0.85): Yellow highlight, officer can accept or correct
- **LOW** (<0.60): Red highlight, officer MUST review before audit proceeds
- If >40% of extracted fields are LOW confidence, flag the entire document for manual entry
- Store these thresholds in configuration so they can be tuned per facility

### 12. Rulepack Versioning Needs Semantic Versioning + Rollback

**Problem:** The spec says "versioned rulepacks" but doesn't define the versioning scheme, activation process, or rollback procedure.

**Recommendation:**
- Use semantic versioning: `MAJOR.MINOR.PATCH` (e.g., `1.3.2`)
- MAJOR = SHA policy change (may change audit outcomes)
- MINOR = new rules added
- PATCH = rule message/description updates
- Each facility stores `active_rulepack_version`
- New rulepacks are downloaded but NOT activated until an admin explicitly activates
- Keep last 3 versions for instant rollback
- Audit results always record which rulepack version was used

---

## MEDIUM PRIORITY (Fix During Implementation)

### 13. Subscription Model Conflicts with On-Prem Data Sovereignty

**Problem:** The Free tier includes "rule engine + basic dashboard" but the Pro tier adds "AI extraction." If the system is fully on-prem, how do you enforce subscription tiers? The hospital has the software running locally.

**Recommendation:** Use a signed license key mechanism:
- Control plane issues time-limited, feature-scoped license tokens
- Local sync agent validates license token (cryptographic, not phone-home)
- License encodes: tier, facility_id, expiry, feature_flags
- ML model files are encrypted; decryption key is part of the Pro license token
- Offline grace period: 30 days without phone-home before features degrade

### 14. No Batch Processing Support

**Problem:** The spec assumes one-claim-at-a-time processing. Hospitals often need to audit dozens of claims from the previous day in the morning.

**Recommendation:** Add batch endpoints:
- `POST /v1/claims/batch-audit` — accepts array of claim IDs, returns job ID
- `GET /v1/jobs/{id}` — poll for batch completion
- UI: "Audit All Pending" button on dashboard
- Batch audit runs claims in parallel (up to configurable concurrency limit)

### 15. No Document Type Taxonomy

**Problem:** The spec references "required forms present" as a rule category but never lists what document types exist in the SHA ecosystem.

**Recommendation:** Define the document type enum:
- `SHA_CLAIM_FORM_1` (Outpatient)
- `SHA_CLAIM_FORM_2` (Inpatient)
- `SHA_CLAIM_FORM_3` (Maternity)
- `PREAUTHORIZATION_FORM`
- `PHYSICIAN_NOTES`
- `LAB_RESULTS`
- `PRESCRIPTION`
- `DISCHARGE_SUMMARY`
- `REFERRAL_LETTER`
- `NATIONAL_ID_COPY`
- `SHA_CARD_COPY`
- Map each SHA benefit package to its required document set

### 16. No SHA Tariff Data Model

**Problem:** "Tariff validation" is listed as a rule category (20 rules) but there's no tariff table, no tariff versioning, and no tariff lookup logic defined.

**Recommendation:** Add:
- `tariffs` table: id, sha_code, description, package_type, max_amount, effective_from, effective_to
- `tariff_versions` table: version_id, published_date, source_url
- Tariff lookup rules should validate: procedure code exists, amount ≤ max_amount, procedure is covered under patient's package
- Tariff data should sync via the same rulepack update mechanism

### 17. Audit Trail Needs Structure

**Problem:** `audit_trail` table is mentioned with zero schema detail. For a compliance system, the audit trail IS the product.

**Recommendation:** Define:
- `id, claim_id, user_id, action_type, action_detail_json, ip_address, user_agent, timestamp`
- `action_type` enum: CLAIM_CREATED, DOCUMENT_UPLOADED, AUDIT_STARTED, FIELD_CORRECTED, AUDIT_OVERRIDDEN, CLAIM_APPROVED, CLAIM_EXPORTED
- Audit trail rows are append-only (no UPDATE, no DELETE ever)
- Separate partition or table for archival after 2 years
- Export to CSV/PDF for regulatory audits

### 18. No Error Recovery for Partial Pipeline Failures

**Problem:** If OCR succeeds on 18 of 20 pages but fails on 2, what happens? The spec doesn't address partial failures in the document processing pipeline.

**Recommendation:**
- Each page is processed independently with its own status
- Claim can proceed to audit with partial extraction (rules that depend on failed pages will fire as INCOMPLETE rather than PASS/FAIL)
- UI shows per-page processing status with retry button for failed pages
- After 3 retries, mark page as MANUAL_ENTRY_REQUIRED

### 19. Handwriting Workspace Needs Keyboard-First Design

**Problem:** The spec describes a left/right panel layout but doesn't address the primary interaction: claims officers rapidly correcting OCR errors.

**Recommendation:**
- Tab key moves between low-confidence fields
- Click on scanned document highlights the corresponding field in the editor
- Click on editor field highlights the bounding box on the scanned document
- Keyboard shortcut to accept all high-confidence extractions
- Auto-save every 5 seconds (not on submit only)
- Undo/redo stack for corrections

### 20. 99.99% Uptime Is Unrealistic for On-Prem Single-Server

**Problem:** 99.99% uptime means <53 minutes of downtime per year. On a single hospital server with no redundancy, this is impossible. Hardware failures, OS updates, and power outages alone will exceed this.

**Recommendation:** Redefine SLAs realistically:
- **Single server:** 99.5% uptime target (reasonable with UPS + auto-restart)
- **With standby server:** 99.9% uptime target
- Add a "degraded mode" spec: if PostgreSQL is up but ML service is down, claims officers can still do manual audits with rule engine only
- The offline-first principle should extend to internal component failures, not just SHA unavailability

### 21. No Data Migration / Initial Setup Workflow

**Problem:** How does a new hospital get onboarded? The spec assumes the system materializes fully configured.

**Recommendation:** Define:
- Hospital registration flow (facility_id, SHA credentials, admin user setup)
- Initial rulepack download and activation
- SHA client registry initial sync (or lookup-on-demand)
- Test mode with sample claims for officer training
- Data import from existing systems (if applicable)

### 22. Docker Compose Is Fine for v1, But Needs Health Checks

**Problem:** The Docker Compose topology lists services but doesn't mention health checks, restart policies, resource limits, or startup ordering.

**Recommendation:**
- Every service needs a `/health` endpoint
- Docker Compose `depends_on` with `condition: service_healthy`
- `restart: unless-stopped` on all services
- Memory limits per container (prevent any one service from OOMing the server)
- Startup order: postgres → rabbitmq/queue → api → ml-service → sync-agent

### 23. Prometheus + Grafana + Loki Is Heavy for v1

**Problem:** Three observability services consuming resources on an already constrained server.

**Recommendation:** For v1, use structured JSON logging to files with logrotate + a simple `/metrics` endpoint that returns key stats (claims processed, audit pass rate, queue depth, error count). Add Prometheus/Grafana in v2 when you have dedicated monitoring infrastructure or a cloud control plane dashboard.

### 24. Missing Rate Limiting and Request Validation

**Problem:** No mention of rate limiting, request size limits, or input sanitization.

**Recommendation:**
- Max file upload size: 50MB per document, 200MB per claim
- Max pages per document: 50
- Rate limit: 100 requests/minute per user (generous for hospital use)
- All string inputs sanitized (SQL injection, XSS in fix reports)
- Request body validation middleware on every endpoint

---

## ARCHITECTURE RECOMMENDATIONS FOR CLAUDE CODE

### 25. Monorepo Structure

For Claude Code to work effectively, organize as a monorepo:
```
claimflow/
├── packages/
│   ├── shared/          # Types, constants, FHIR mappings
│   ├── rule-engine/     # Deterministic rules + rulepack loader
│   ├── api/             # Fastify/Hono API server
│   ├── ml-service/      # Python FastAPI (only service in Python)
│   ├── sync-agent/      # Control plane communication
│   └── web/             # Next.js dashboard
├── rulepacks/           # YAML rule definitions
├── docker/              # Dockerfiles + compose
├── migrations/          # Database migrations (numbered)
├── scripts/             # Dev tooling
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 26. Build Order for Claude Code Sessions

Implement in this sequence (each step is a testable milestone):

1. **Database schema + migrations** — get the data model right first
2. **Shared types package** — claim states, document types, rule structures
3. **Rule engine core** — load YAML, execute rules against claim data, return results
4. **First 20 rules** — identity + documentation categories
5. **API: claims CRUD** — create, read, update status, list with filters
6. **API: document upload** — file storage, metadata, checksum
7. **Audit pipeline** — orchestrate: extract → rules → persist results
8. **ML service** — OCR endpoint (Tesseract first), document classifier
9. **Web: claims dashboard** — list, filter, status badges
10. **Web: audit workspace** — document viewer + extraction editor
11. **Remaining 100 rules** — clinical, authorization, financial, structural
12. **Fix report generation** — markdown output from rule results
13. **Sync agent** — rulepack updates, anonymized metrics upload
14. **Auth** — JWT, RBAC, TOTP
15. **Docker Compose** — full deployment topology

### 27. Test Strategy

- **Rule engine:** 100% unit test coverage. Every rule has at least one PASS and one FAIL test case.
- **API:** Integration tests with test database (use testcontainers)
- **ML service:** Benchmark tests with a fixed set of sample documents (track accuracy over time)
- **E2E:** Playwright tests for critical flows (create claim → upload docs → run audit → view report)

### 28. Configuration Management

Use environment variables with a typed config loader:
```
CLAIMFLOW_DB_URL=postgres://...
CLAIMFLOW_STORAGE_PATH=/data/documents
CLAIMFLOW_ML_SERVICE_URL=http://ml-service:8000
CLAIMFLOW_RULEPACK_DIR=/data/rulepacks
CLAIMFLOW_LICENSE_KEY=eyJ...
CLAIMFLOW_LOG_LEVEL=info
```
Never hardcode URLs, paths, or credentials.

---

## ADDITIONAL DOMAIN-SPECIFIC RECOMMENDATIONS

### 29. SHA Client Registry Integration Needs Caching

SHA's API may be slow or unavailable. Cache patient SHA ID lookups locally with a TTL of 24 hours. Stale cache entries should still allow audit to proceed with a WARNING rather than HARD_STOP.

### 30. ICD-10/ICD-11 Code Validation Needs a Local Database

Don't call external APIs for ICD code validation. Ship a local SQLite database of valid ICD-10 codes (WHO publishes this). Update it via the sync mechanism.

### 31. Preauthorization Validation Is Underspecified

The spec lists "preauthorization validation" as 15 rules but doesn't define what preauthorization data looks like, where it comes from, or how it maps to claim documents. This needs a separate data model and integration specification.

### 32. Multi-Language Support

Kenyan hospitals operate in English and Swahili. The UI and fix reports should support both languages from v1. This means:
- All UI strings in i18n files (not hardcoded)
- Fix report templates in both languages
- Rule messages in both languages

### 33. PDF Generation for Compliance Reports

Hospitals need to print audit reports. Add a PDF export for:
- Individual claim audit reports
- Daily/weekly compliance summaries
- Batch audit results

### 34. Claim Attachment Validation Beyond OCR

Some documents don't need OCR — they need existence validation:
- Is there a national ID copy? (Yes/No, not "what does it say?")
- Is the SHA card image legible? (Image quality check, not text extraction)
- Are lab results from an accredited facility? (Check facility stamp/header)

### 35. Network Resilience for SHA Lookups

Implement circuit breaker pattern for all external API calls (SHA registry, AfyaLink). After 5 consecutive failures, stop trying for 5 minutes. Log degraded mode entry/exit.

### 36. Encryption Key Management Without Vault for v1

HashiCorp Vault is enterprise-grade and complex. For v1 single-server:
- Use OS-level disk encryption (LUKS)
- Application-level encryption keys in a file readable only by the app user, loaded at startup
- Rotate keys via sync agent when control plane issues new keys
- Move to Vault when multi-site deployment requires centralized key management

### 37. Claim Deduplication

No mention of detecting duplicate claim submissions. Add a deduplication check based on: patient_id + facility_id + admission_date + primary_diagnosis. Flag potential duplicates with a WARNING rule.

### 38. Audit Override With Reason

Claims officers need the ability to override a FAILED audit with documented justification. This is common in healthcare — edge cases exist that rules can't cover. The override must:
- Require a text reason (minimum 20 characters)
- Be logged in audit_trail with the officer's identity
- Be flagged for supervisor review
- Be included in compliance reports

### 39. Dashboard Analytics Must Include Actionable Metrics

The spec mentions "top failing rules" but the dashboard should prioritize actionable intelligence:
- **This week's rejection risk** — claims currently in FAILED status with common patterns
- **Officer productivity** — claims audited per officer per day
- **Rule change impact** — after rulepack update, how did pass/fail rates change?
- **Document quality trends** — which document types have the worst OCR accuracy?

### 40. Backup Strategy Needs RPO/RTO Definitions

"Daily backups" is insufficient. Define:
- **RPO (Recovery Point Objective):** Maximum 1 hour of data loss (use WAL archiving for PostgreSQL, not just daily dumps)
- **RTO (Recovery Time Objective):** System restored within 2 hours
- Backup verification: automated monthly restore tests
- Document backup to separate physical storage (USB drive rotation is acceptable for v1)

---

## SPECIFICATION INCONSISTENCIES TO RESOLVE

### 41. Section 6 vs Section 8 Conflict
Section 6 says "Micro-Kernel architecture" but Section 8 describes standard microservices. These are different patterns. For v1 on a single server, this is effectively a **modular monolith deployed as containers** — call it what it is.

### 42. Workflow Orchestrator Is Underspecified
Section 8.4 lists 3 bullet points. This is the most critical coordination component and gets the least detail. It needs: saga pattern for multi-step audit, compensation logic for failures, timeout handling, and state machine definition.

### 43. Rule Engine Appears Twice
Sections 3 (within microservices) and 11 (standalone section) describe the rule engine differently. Consolidate into one authoritative definition.

### 44. Audit Output vs Fix Report Overlap
Sections 15 and 16 describe overlapping output structures. Clarify: the audit output (Section 15) is the machine-readable result; the fix report (Section 16) is the human-readable rendering of that result.

### 45. Sync Agent Responsibilities Unclear
Section 8.5 says "send anonymized analytics" but Section 29 defines governance modes. The sync agent's exact behavior per governance mode needs a decision matrix.

### 46. Missing: What "Deterministic" Actually Means in Practice
The spec repeatedly says "deterministic" but some rules inherently depend on ML output (e.g., "physician signature present" requires the signature detector). Define clearly: rules are deterministic, but their INPUTS may have probabilistic components. The rule engine treats ML outputs above a confidence threshold as true/false, making the rule execution deterministic even though inputs aren't.

### 47. No Versioning Strategy for the API Itself
The spec shows `/v1/` in endpoints but doesn't discuss API versioning policy. Define: when is v2 created? How long is v1 supported? Can a facility run an older API version with a newer rulepack?

---

## SUMMARY: PRIORITY ACTION LIST

| Priority | Items | Action |
|----------|-------|--------|
| **CRITICAL** | #1-5 | Resolve before any code is written |
| **HIGH** | #6-12 | Resolve during Sprint 0 (architecture setup) |
| **MEDIUM** | #13-24 | Address during implementation sprints |
| **ARCHITECTURE** | #25-28 | Follow these patterns in Claude Code sessions |
| **DOMAIN** | #29-40 | Incorporate as implementation proceeds |
| **CLEANUP** | #41-47 | Update specification document |

The most impacthat single change is **#1 (TypeScript instead of Go)** — it halves your implementation time, unifies the stack for Claude Code generation, and loses nothing at v1 scale. The second most impactful is **#2 (lighter ML stack)** — it makes the 8-CPU server spec actually viable and gets you to a working product months faster.

---

# PART 5: REVISED SPEC CROSS-REFERENCE AUDIT

---

# ClaimFlow Revised Specification — Cross-Reference Audit
## Expert Panel Re-Assessment Against 47 Original Recommendations

**Document Reviewed:** ClaimFlow v1→v3 Upgraded Specification (24 sections)
**Reviewed Against:** Expert Panel Review (47 recommendations)
**Date:** March 2026

---

## EXECUTIVE SUMMARY

The revised specification addresses **31 of 47 recommendations** substantively. This is a massive improvement — the document has moved from "architecturally aspirational" to "nearly implementable." However, **16 gaps remain**, several of which will cause real problems during Claude Code implementation if left unresolved. The most dangerous pattern in the revised spec is **stating that something is addressed but leaving the actual implementation detail empty** — Claude Code cannot infer what was left implicit.

| Status | Count | Meaning |
|--------|-------|---------|
| FULLY ADDRESSED | 22 | Recommendation absorbed with sufficient detail |
| PARTIALLY ADDRESSED | 9 | Mentioned but missing implementation-critical detail |
| NOT ADDRESSED | 16 | Missing entirely from revised spec |

---

## ITEM-BY-ITEM SCORECARD

### CRITICAL ITEMS (#1–5)

**#1 — Language Choice (Go → TypeScript):** ✅ FULLY ADDRESSED
The revised spec adopts TypeScript + Fastify for API and rule engine, Python FastAPI for ML only, with optional Go for ingestion. This is correct. The monorepo structure in Section 5 reflects this cleanly.

**#2 — Realistic ML Stack:** ✅ FULLY ADDRESSED
Section 14 specifies Tesseract 5 + PaddleOCR, lightweight CNN for doc classification, contour heuristics for signatures. Escalation path to LayoutLMv3/TrOCR is gated on hardware and data availability. Confidence thresholds defined (0.85/0.60). Partial failure handling specified per-page. This is excellent.

**#3 — API Contract Definitions:** ⚠️ PARTIALLY ADDRESSED
Section 8 lists all endpoints with correct HTTP verbs, cursor pagination, idempotency keys, and error taxonomy (RULE_HARD_STOP, CONCURRENCY_CONFLICT, etc.). However, **no actual request/response JSON schemas are defined**. The endpoints are named but the bodies are empty. For Claude Code to generate correct handlers, we need:
- Exact request body shapes for POST /v1/claims, POST /v1/claims/{id}/documents, etc.
- The response envelope `{ data, meta, errors }` is mentioned but never shown with concrete field types
- Query parameter types and defaults for GET /v1/claims (cursor type, status enum, date format)
- Multipart upload specification for document endpoint

**Action Required:** Produce a full OpenAPI 3.1 YAML file as the very first Claude Code artifact. This is Sprint 0, Step 0 — before database migrations.

**#4 — Database Schema:** ✅ FULLY ADDRESSED
Section 9 is comprehensive. All recommended tables are present: tenants, facilities, users, mfa_devices, claims, claim_lines, documents, document_pages, extracted_fields, corrections, rulepacks, rulepack_rules, audit_sessions, rule_results, audit_trail, outbox_events, sync_events, tariff_versions, tariffs. The `version` column for optimistic concurrency is on claims. `bbox_json` is on extracted_fields. `document_pages` table for partial failure tracking is a smart addition beyond what we recommended.

One gap: `claim_lines` is listed but column details are sparse ("sha_code, qty, unit_price, total, diagnosis_code, procedure_code, …"). The "…" will cause Claude Code to improvise. **Define all columns explicitly before migration generation.**

**#5 — FHIR R4 Mapping:** ✅ FULLY ADDRESSED
Section 12 maps all ClaimFlow entities to FHIR resources and references AfyaLink documentation for bundle structure. Shadow validation is correctly deferred to v2 with deterministic validation rules defined. The mapping includes Health Worker Registry for practitioner lookup, which was missing from the original spec.

---

### HIGH PRIORITY ITEMS (#6–12)

**#6 — Keycloak Removal:** ✅ FULLY ADDRESSED
Section 17 replaces Keycloak with in-app JWT RS256 + TOTP + RBAC in DB + step-up auth. Correct decision.

**#7 — RabbitMQ → Postgres Queue:** ✅ FULLY ADDRESSED
Section 15 adopts pg-boss/graphile-worker with a `JobBus` interface abstraction, keeping RabbitMQ as an enterprise option. The interface pattern means no code rewrite if switching later. Well handled.

**#8 — MinIO → Filesystem:** ✅ FULLY ADDRESSED
Section 16 specifies local filesystem with `DocumentStore` interface and structured paths. MinIO deferred to v2 for multi-node.

**#9 — Claim Lifecycle State Machine:** ✅ FULLY ADDRESSED
Section 6 defines all states, valid transitions, and specifies that every transition emits to audit_trail. One minor gap: the spec shows `AUDIT_COMPLETE → PASSED | WARNING | FAILED` as a single transition, but these should be three distinct transition events. Clarify whether AUDIT_COMPLETE is a transient state that immediately resolves, or whether it persists briefly.

**#10 — Concurrency / Locking:** ✅ FULLY ADDRESSED
Section 7 specifies optimistic concurrency with version numbers, If-Match headers, 409 responses, and advisory locks with TTL heartbeat for editing sessions. Sufficient for implementation.

**#11 — OCR Confidence Thresholds:** ✅ FULLY ADDRESSED
Defined in Section 14: HIGH >0.85, MED 0.60–0.85, LOW <0.60, with >40% LOW triggering manual entry. Thresholds are in environment variables (CONF_HIGH, CONF_LOW in Docker Compose), making them tunable per facility.

**#12 — Rulepack SemVer + Rollback:** ✅ FULLY ADDRESSED
Section 10 defines MAJOR/MINOR/PATCH semantics, inert-until-activated deployment, last 3 versions for rollback, and per-audit version recording. i18n messaging (EN/SW) from day 1 is an excellent addition.

---

### MEDIUM PRIORITY ITEMS (#13–24)

**#13 — Subscription Licensing:** ✅ FULLY ADDRESSED
Section 18 defines signed license tokens with tier, facility_id, expiry, feature flags, 30-day offline grace, and encrypted ML models for Pro gating.

**#14 — Batch Processing:** ✅ FULLY ADDRESSED
Section 19 adds batch audit endpoint with concurrency cap and job progress view. Section 8 includes the batch-audit API endpoint.

**#15 — Document Type Taxonomy:** ✅ FULLY ADDRESSED
Section 11 defines 12 document types including SHA claim forms by type (OP/IP/Maternity), preauth forms, clinical documents, and identity documents. Maps benefit-package → required docs via rulepack params.

**#16 — SHA Tariff Data Model:** ✅ FULLY ADDRESSED
Section 9 includes tariff_versions and tariffs tables with sha_code, package_type, max_amount, effective dates.

**#17 — Audit Trail Structure:** ✅ FULLY ADDRESSED
Section 9 defines the audit_trail table as append-only with structured action types. Action type enum is listed. However, two details are missing:
- **No mention of retention policy or archival.** For a compliance system, define: how long are audit trail records kept? Is there a partition strategy?
- **No export specification.** The original recommendation called for CSV/PDF export for regulatory audits. The spec mentions "CLAIM_EXPORTED" as an action type but doesn't define the export format.

**#18 — Partial Pipeline Failure Recovery:** ✅ FULLY ADDRESSED
Section 14 specifies page-by-page processing, 3 retries before manual entry, and rules on failed pages returning INCOMPLETE. The `document_pages` table in Section 9 tracks per-page status.

**#19 — Handwriting Workspace Keyboard Design:** ❌ NOT ADDRESSED
The revised spec drops the handwriting workspace UX entirely. Section 22 (build order) mentions "keyboard-first correction UX" as step 9 but provides zero design detail. For Claude Code to build this correctly, we need:
- Tab-navigation between low-confidence fields
- Bidirectional click linking (document ↔ editor)
- Keyboard shortcut map (accept-all, undo, redo, next-field, previous-field)
- Auto-save interval specification
- Split-pane layout proportions and responsive behavior

**#20 — Realistic Uptime SLAs:** ✅ FULLY ADDRESSED
Section 1 redefines: 99.5% for single server, 99.9% with warm standby. Degraded mode explicitly defined. The p95 latency target raised from 8.5s to 20s for full pipeline, which is realistic for CPU inference.

**#21 — Onboarding / Initial Setup Workflow:** ❌ NOT ADDRESSED
No mention of hospital onboarding flow anywhere in the revised spec. This is a real gap:
- How does a new facility get registered?
- Who creates the first admin user?
- How is the initial rulepack provisioned?
- Is there a test/training mode with sample claims?
- What's the SHA credential setup process?
- Data import from existing HMIS systems?

**#22 — Docker Compose Health Checks:** ✅ FULLY ADDRESSED
Section 21 includes health checks on postgres, restart policies (`unless-stopped`), and proper `depends_on` with `condition: service_healthy`. Resource limits are mentioned for enterprise but not defined for minimal — should add memory caps.

**#23 — Slim Observability:** ✅ FULLY ADDRESSED
Section 20 specifies JSON logs + logrotate + /metrics endpoint with key counters. Prometheus/Grafana/Loki deferred to v2. Correct.

**#24 — Rate Limiting / Input Validation:** ❌ NOT ADDRESSED
No mention of rate limiting, max upload sizes, max page counts, or input sanitization anywhere in the revised spec. This is a security gap:
- Max file upload size per document
- Max total upload size per claim
- Max pages per document
- Rate limiting per user/IP
- String sanitization (SQL injection prevention, XSS in fix reports rendered as markdown)
- Request body size limits

---

### ARCHITECTURE RECOMMENDATIONS (#25–28)

**#25 — Monorepo Structure:** ✅ FULLY ADDRESSED
Section 5 defines the exact structure recommended, including packages/shared, rule-engine, api, web, sync-agent, ml-service, plus rulepacks, migrations, docker, scripts, tests.

**#26 — Build Order:** ✅ FULLY ADDRESSED
Section 22 follows the recommended sequence with minor reordering (OpenAPI contracts moved to step 4, auth moved to step 11). The reordering is acceptable — getting claims CRUD working before auth lets you test the core pipeline faster.

**#27 — Test Strategy:** ❌ NOT ADDRESSED
The monorepo has a `tests/` directory with unit/integration/e2e subdirectories, but there is zero specification of:
- What coverage target per package (rule engine should be 100%)
- What test tooling (Vitest? Jest? Playwright for e2e?)
- Whether every rule requires PASS + FAIL test cases
- Integration test strategy (testcontainers for Postgres?)
- ML benchmark test set (fixed documents with known expected outputs)
- CI pipeline definition

Without test specifications, Claude Code will generate code without tests, and you'll accumulate untested rules that silently break.

**#28 — Configuration Management:** ⚠️ PARTIALLY ADDRESSED
The Docker Compose in Section 21 shows environment variables (DATABASE_URL, STORAGE_PATH, ML_SERVICE_URL, etc.), which implicitly defines the config surface. But there's no typed config loader specification — no validation of required variables at startup, no config schema, no documentation of all config keys and their defaults. Claude Code needs a `config.ts` schema to generate services that fail fast on misconfiguration.

---

### DOMAIN-SPECIFIC RECOMMENDATIONS (#29–40)

**#29 — SHA Client Registry Caching:** ✅ FULLY ADDRESSED
Section 13 specifies 24h TTL cache, circuit breaker (5 failures → 5 min open), degraded mode UI banner, and configurable HARD_STOP vs WARNING per rulepack.

**#30 — ICD-10 Local Database:** ❌ NOT ADDRESSED
No mention of shipping a local ICD-10 code database. The spec references "ICD/Procedure" code validation in the FHIR mapping section but doesn't specify how codes are validated. Without a local database, every ICD validation requires an external lookup, which breaks the offline-first principle.

**Action Required:** Ship a SQLite or Postgres table of ICD-10 codes (WHO publishes the full set). Sync updates via the rulepack mechanism.

**#31 — Preauthorization Data Model:** ❌ NOT ADDRESSED
The spec lists PREAUTH_FORM as a document type and mentions preauthorization in the FHIR mapping, but there's no preauth-specific data model:
- What does a preauthorization record look like?
- Where is the preauth number stored?
- How does ClaimFlow validate that a preauth exists and covers the claimed services?
- Is preauth lookup local or via SHA API?

This matters because ~15 rules in the original catalog were preauthorization rules.

**#32 — Multi-Language i18n:** ⚠️ PARTIALLY ADDRESSED
Section 10 adds i18n for rule messages (message_i18n_json with EN/SW). But this only covers rule messages — what about:
- UI strings (all labels, buttons, navigation, error messages)
- Fix report templates
- Email notifications (if any)
- PDF export headers and labels
- Error messages from the API

The Next.js frontend needs an i18n framework decision (next-intl, react-i18next, etc.) and a string extraction strategy from day 1.

**#33 — PDF Generation for Compliance Reports:** ⚠️ PARTIALLY ADDRESSED
Section 3 mentions "Export evidence pack (PDF + JSON + hashes)" as a v1 deliverable. This is good — it's more than we recommended (adding hashes for evidence integrity). But there's no specification of:
- PDF template design
- What exactly goes into the evidence pack
- Whether the PDF is a rendering of the fix report or a comprehensive audit certificate
- Library choice for PDF generation (puppeteer? @react-pdf? wkhtmltopdf?)

**#34 — Attachment Validation Beyond OCR:** ❌ NOT ADDRESSED
No distinction between documents that need OCR (claim forms, physician notes) versus documents that need existence/quality checks only (national ID copy, SHA card). The ML pipeline should have a routing step: document type → processing strategy. Some documents just need:
- Existence confirmed (✓/✗)
- Image quality check (blur, DPI, completeness)
- No OCR at all

This would significantly reduce processing time and ML resource consumption.

**#35 — Circuit Breaker for External Calls:** ✅ FULLY ADDRESSED
Section 13 defines the pattern completely: 5 failures → 5 min open circuit, logging, UI degraded banner.

**#36 — Encryption Key Management Without Vault:** ❌ NOT ADDRESSED
The revised spec dropped Vault references (good) but didn't replace it with anything. How are encryption keys for PHI at rest managed?
- Where is the encryption key stored?
- How is it loaded at startup?
- What's the key rotation procedure?
- Is disk encryption (LUKS) recommended?

The spec says "No PHI in plaintext at rest" (Section 2) but doesn't define the encryption implementation.

**#37 — Claim Deduplication:** ❌ NOT ADDRESSED
No deduplication check defined. Hospitals will accidentally submit the same claim twice — patient_id + facility_id + admission_date + primary_diagnosis overlap should trigger a WARNING rule.

**#38 — Audit Override with Reason:** ⚠️ PARTIALLY ADDRESSED
Section 2 mentions "dual-control override with step-up auth + full audit trail" for missing clinician attestation. But this is only for one specific override scenario. The general override mechanism needs:
- Override available for any FAILED audit (not just signature issues)
- Minimum reason length (20 characters)
- Supervisor review flag
- AUDIT_OVERRIDDEN action type is listed in audit_trail — good
- Override claims should be separately reportable for compliance

**#39 — Dashboard Analytics:** ❌ NOT ADDRESSED
Section 8 lists dashboard endpoints (GET /v1/dashboard/overview, /rules/top-failures, /ml-health) but provides zero specification of what data these return. The dashboard is the primary product surface — users will judge ClaimFlow by what they see. Define:
- Overview: claims today/week/month, pass/fail/warning counts, average audit time
- Top failures: rule_id, category, failure count, trend (up/down), affected claims list
- Officer productivity: claims per officer per day
- Document quality: OCR accuracy by document type
- Rulepack impact: pass rate change after version update

**#40 — Backup RPO/RTO:** ❌ NOT ADDRESSED
Section 23 mentions failure conditions but there's no backup specification at all. The original spec had "daily backups" — the revised spec dropped even that. Define:
- RPO: 1 hour (Postgres WAL archiving, not just daily pg_dump)
- RTO: 2 hours
- What gets backed up: database, documents, rulepacks, config
- Where backups go: secondary local storage + optional remote
- Backup verification: monthly automated restore test

---

### SPECIFICATION INCONSISTENCIES (#41–47)

**#41 — Micro-Kernel vs Microservices naming:** ⚠️ PARTIALLY ADDRESSED
The revised spec drops the "micro-kernel" terminology and describes a practical container topology. But it never explicitly names the pattern. Call it what it is: "modular monolith deployed as containers." This matters for Claude Code because the implementation strategy for a modular monolith (shared database, in-process function calls between modules) differs from microservices (separate databases, HTTP/queue communication between services).

**#42 — Workflow Orchestrator detail:** ❌ NOT ADDRESSED
The revised spec doesn't mention the workflow orchestrator at all. The audit pipeline (extract → rules → persist) needs orchestration logic:
- What happens if extraction succeeds but rule evaluation fails mid-way?
- Is there a saga pattern with compensation?
- Timeout handling: what if ML service doesn't respond within 60s?
- Retry logic for the overall pipeline (distinct from queue retry)

**#43 — Rule Engine duplication:** ✅ FULLY ADDRESSED
Consolidated into a single Section 10 with clear scope.

**#44 — Audit Output vs Fix Report overlap:** ⚠️ PARTIALLY ADDRESSED
The spec mentions both audit_sessions (with decision, scores) and fix_report_markdown but doesn't clearly separate the machine-readable result from the human-readable rendering. Define:
- `audit_result` (JSON) = machine-readable, stored in DB, used by API
- `fix_report` (Markdown/PDF) = human-readable, generated from audit_result, displayed in UI and evidence pack

**#45 — Sync Agent behavior per governance mode:** ❌ NOT ADDRESSED
The governance modes (METRICS_ONLY, DEIDENTIFIED, FULL_ANALYTICS) are mentioned in Section 2 (METRICS_ONLY as default) but there's no decision matrix for what the sync agent transmits in each mode:
- METRICS_ONLY: claim counts, pass/fail rates, latency stats, rule failure frequencies — no claim data
- DEIDENTIFIED: above + anonymized claim snapshots for model training
- FULL_ANALYTICS: above + facility-level claim details

**#46 — "Deterministic" definition with ML inputs:** ⚠️ PARTIALLY ADDRESSED
Section 2 states "Same claim snapshot + same rulepack version => bitwise reproducible audit output" and "ML outputs never override deterministic PASS/FAIL." This is clearer than before but still doesn't address the key nuance: **extracted_fields ARE part of the claim snapshot.** So if you re-run OCR and get different extraction, the audit result changes. The determinism guarantee is: given fixed extracted_fields + fixed rulepack → identical audit output. The non-deterministic part is the extraction step. This distinction matters for reproducibility claims and regulatory audits.

**#47 — API versioning policy:** ❌ NOT ADDRESSED
The spec uses `/v1/` in endpoints but doesn't define when v2 is created, backward compatibility guarantees, or deprecation timeline.

---

## NEW ISSUES FOUND IN REVISED SPEC

Beyond the 47 original items, the revised spec introduces new elements that need attention:

### N1 — Chatbot in v1 Scope Is Risky

Section 3 adds "Chatbot for 'how to fix this claim' grounded in rulepack + claim snapshot" to v1 scope. This is a significant feature that requires:
- LLM integration (which LLM? On-prem or API call?)
- Prompt engineering with rulepack + claim context injection
- Guardrails against hallucinated advice
- PHI handling in prompts (if claim data is sent to external LLM, this violates data sovereignty)

**Recommendation:** Move chatbot to v1.5 or v2. For v1, the fix report markdown with clear remediation instructions (already specified in rule messaging) is sufficient. If the chatbot is non-negotiable for v1, it MUST use a local model (e.g., Phi-3, Llama 3) to maintain data sovereignty, which adds significant hardware requirements.

### N2 — claim_lines Table Needs Full Definition

The `claim_lines` table has "…" in its column list. Every table that touches financial validation must be fully defined. Add at minimum:
- id, claim_id, line_number, sha_benefit_code, icd_code, procedure_code, quantity, unit_price, total_amount, description, preauth_number (nullable), status, created_at

### N3 — Missing: Password Policy and Account Lockout

The auth section specifies JWT + TOTP but doesn't mention:
- Password complexity requirements
- Account lockout after N failed attempts
- Password reset flow (who resets? Is there email-based reset or admin-only?)
- Session timeout

### N4 — Missing: Data Retention and Purge Policy

For a system handling PHI, there must be a data retention policy:
- How long are claim documents stored?
- When are extracted fields purged?
- Is there a right-to-deletion mechanism?
- Kenya Data Protection Act 2019 compliance considerations

### N5 — Docker Compose Uses Postgres 16, Not 17

Section 21 specifies `postgres:16` but the original spec called for PostgreSQL 17. Minor, but pick one and be consistent. Postgres 17 is recommended for the improved JSON and logical replication features.

### N6 — Missing: Deployment and Update Procedure

How does a hospital update ClaimFlow? The sync agent receives "software updates" but there's no specification of:
- Rolling update vs. maintenance window
- Database migration strategy during updates
- Rollback procedure if an update breaks
- Version compatibility matrix (which API version works with which rulepack version)

---

## PRIORITY ACTION LIST FOR CLAUDE CODE START

These items must be resolved before the first Claude Code session:

| Priority | Item | Action |
|----------|------|--------|
| **P0** | Full OpenAPI 3.1 spec | Define all request/response schemas, not just endpoint paths |
| **P0** | claim_lines full column definition | Complete the "…" in the schema |
| **P0** | Decide chatbot scope | v1 or v2? If v1, specify LLM + PHI handling |
| **P1** | Test strategy specification | Coverage targets, tooling, rule test requirements |
| **P1** | Typed config schema | All env vars with types, defaults, validation |
| **P1** | Encryption key management | How PHI at-rest encryption actually works |
| **P1** | Audit workspace UX specification | Keyboard nav, split pane, auto-save |
| **P2** | ICD-10 local database | Ship codes locally, don't depend on external API |
| **P2** | Dashboard response schemas | What each dashboard endpoint actually returns |
| **P2** | Onboarding workflow | New facility setup from zero to first audit |
| **P2** | Backup and recovery spec | RPO/RTO, WAL archiving, restore procedure |
| **P2** | Document processing routing | Which doc types need OCR vs. existence-only check |
| **P3** | Rate limiting + input validation | Upload limits, request limits, sanitization |
| **P3** | Preauth data model | Structure, storage, validation approach |
| **P3** | Deduplication rules | patient + facility + date + diagnosis overlap detection |
| **P3** | Workflow orchestrator logic | Saga pattern, timeouts, compensation for pipeline failures |

---

## FINAL ASSESSMENT

The revised spec has absorbed the panel's most impactful recommendations — language choice, realistic ML, complete schema, state machine, concurrency, FHIR mapping, and slim infrastructure. The architectural decisions are now sound for a v1 product built with Claude Code by a small team.

The remaining gaps cluster into two categories: **operational specifications** (onboarding, backups, updates, encryption) and **UI/UX detail** (dashboard content, audit workspace interaction, chatbot scope). These are precisely the areas where Claude Code will either improvise poorly or stall without direction.

**Net recommendation:** Produce the OpenAPI 3.1 spec and the typed config schema as the first two Claude Code outputs. Everything else can be resolved iteratively during implementation sprints, but those two artifacts unlock all subsequent code generation.
