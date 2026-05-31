# Multi-Payer & Public API — Design

Status: **Phase 1 in progress.** This document describes the target architecture for
turning ClaimFlow from a single-payer (SHA) audit engine into a multi-payer,
hosted-SaaS platform with a public machine-facing API, and records the decisions
already implemented.

## Product decisions (locked)

1. **Hosted SaaS.** ClaimFlow runs on our infrastructure; PHI flows to our servers.
   This makes Kenya Data Protection Act (DPA) 2019 compliance a launch gate, not an
   optional extra. Tenant isolation is a security boundary between *different customer
   organizations*, not just facilities.
2. **Multi-payer from day one.** A claim is audited against a *payer-specific* rulepack.
   The user selects the insurer (SHA, AAR, Jubilee, CIC, …) per claim or per batch from a
   dropdown. The dropdown is data-driven: it reads the payer catalog endpoint, never a
   hardcoded list.

## Core abstraction: the payer catalog

A **payer** is global reference data (like ICD codes or SHA service codes) — every tenant
audits against the same SHA / AAR / Jubilee / CIC rules — so the catalog is intentionally
**not** tenant-scoped.

Each payer maps to a namespaced, versioned rulepack. The on-disk layout generalizes from
the single flat SHA pack to a payer-keyed tree:

```
rulepacks/
  v1.0.0/            # legacy flat layout = the default SHA pack (unchanged)
  sha/v1.1.0/        # future SHA packs may move under the sha/ namespace
  aar/v1.0.0/        # each new payer is a new directory — data, not a refactor
  jubilee/v1.0.0/
  cic/v1.0.0/
```

`loadRulepack(dir, version, payerSlug?)` resolves `<dir>/<payerSlug>/<version>/` when a
payer is given, and the legacy `<dir>/<version>/` when it is not. It deliberately does
**not** fall back from a named payer to the flat layout: a missing payer rulepack must
error rather than silently audit a claim against another payer's rules.

`PayerStatus` gates what the catalog exposes:
- `ACTIVE` — rulepack authored and available; claims can be audited.
- `COMING_SOON` — listed so the UI can show the payer, but no rulepack yet (no weak audits).
- `INACTIVE` — hidden / disabled.

## What Phase 1 delivers in this slice

- **Shared domain** — `Payer` type + `PayerStatus` enum (`packages/shared/src/types/payer.ts`),
  exported from the barrel; `ListPayersQuerySchema` / `PayerSlugParamSchema` Zod schemas.
- **Payer catalog table** — migration `016_payers.sql`: global `payers` table seeded with
  SHA (`ACTIVE`, rulepack `1.0.0`) and AAR / Jubilee / CIC (`COMING_SOON`). Adds a nullable
  `claims.payer_id` FK (NULL ⇒ default SHA) for forward compatibility.
- **Payer-aware rule loading** — `loadRulepack` / `createRuleEngine` accept an optional
  `payerSlug`, with backward-compatible flat-layout resolution and no silent cross-payer
  fallback (covered by `loader.payer.test.ts`).
- **Read API** — `GET /v1/payers` (the dropdown's data source) and `GET /v1/payers/:slug`,
  backed by `payer-service.ts`.

## Next slices

2. **Thread payer through claims & audit** — accept `payerId` on claim create and on the
   batch-audit job; the audit pipeline selects a per-payer `RuleEngine` (one engine per
   payer slug, lazily loaded) and records the exact payer + rulepack version on every audit
   session for determinism and auditability.
3. **Public API & machine auth** — API keys (hashed, scoped, revocable) alongside the human
   JWT/MFA dashboard auth; OpenAPI 3.1 generated from the shared Zod schemas; per-key
   metering, quotas, and webhooks (via the existing outbox).
4. **DPA 2019 compliance hardening** (runs in parallel; gates real-customer launch) —
   in-Kenya residency, encryption at rest, retention/deletion, consent metadata, breach
   readiness, customer Data Processing Agreements.

## Slice 2 — thread payer through claims & audit

> Status: **implemented** (PR for Phase 1 slice 2). `payerId` is accepted on claim creation
> (defaulting to SHA, fail-closed on non-ACTIVE payers), the audit pipeline selects a
> per-payer `RuleEngine` via a lazily-cached registry, and every audit session records the
> payer (`payer_id` / `payer_slug`) alongside the rulepack version + checksum. Follow-ups
> (claims backfill + `payer_id NOT NULL`) tracked in `PROGRESS.md` as backlog item 2.

Goal: every claim carries an explicit payer, the audit pipeline evaluates each claim against
*its own payer's* rulepack, and each audit session immutably records which payer + rulepack
version produced the decision — preserving determinism and a reproducible audit trail.

### 1. Payer on claim creation

- **Schema (`@claimflow/shared`)**: `CreateClaimSchema` gains `payerId: z.string().uuid().optional()`.
  When omitted, the service resolves and stores the default **SHA** payer id explicitly
  (we persist the real id rather than relying on `NULL`-⇒-SHA, which sets up the
  `payer_id NOT NULL` follow-up). The `Claim` type gains `payerId: string` plus denormalized
  `payerSlug` / `payerName` for display in responses.
- **`claim-service` create**: resolve the payer, persist `payer_id`, and **fail closed** on a
  payer that is unknown or not `ACTIVE` (e.g. `COMING_SOON`) → `400 VALIDATION_ERROR`. This
  prevents creating claims that cannot be audited.
- **Reads**: `GET /v1/claims/:id` and the list endpoint include `payerId` / `payerSlug` /
  `payerName` (join against the global `payers` catalog).

### 2. Per-payer RuleEngine registry

- New module `packages/api/src/workflows/rule-engine-registry.ts`:
  `createRuleEngineRegistry(config, payerLookup)` returning
  `getEngineForPayer(payer): Promise<RuleEngine>`.
- Maintains a `Map<payerSlug, RuleEngine>`; the engine for a slug is created **once, lazily**,
  via `createRuleEngine(config.RULEPACK_DIR, payer.rulepackVersion, slugArg)` and cached. Each
  engine internally caches its loaded rulepack (existing behavior), so a rulepack is read from
  disk at most once per payer per process.
- **SHA special-case**: for slug `sha`, the engine is created with `payerSlug` **undefined** so
  it resolves the legacy flat `rulepacks/<version>/` layout — no files move. Every other payer
  passes its slug and resolves `rulepacks/<slug>/<version>/`.
- **Fail closed**: if a payer has no `rulepackVersion` (e.g. `COMING_SOON`) the registry throws a
  typed domain error rather than returning a fallback engine — no claim is ever audited against
  another payer's rules.
- **Determinism**: the engine bound to a slug is stable for the process; the rulepack version is
  read from the catalog at audit time and **snapshotted onto the audit session** (below), so a
  later change to a payer's active version never alters historical results.

### 3. Audit pipeline & batch wiring

- `AuditPipelineService` replaces its single `this.ruleEngine` with the registry. In
  `executeAuditPipeline`, after loading the claim it resolves the claim's payer, calls
  `registry.getEngineForPayer(payer)`, then `engine.evaluate(input, locale)` as today.
- **Batch audit**: payer lives on each claim, so batch needs no single batch-wide payer — the
  handler audits each claim against the claim's own `payer_id` (supports mixed-payer batches).
  `BatchAuditSchema` gains an optional `filter.payerId` to *scope* which claims are selected.
- The persisted `audit_sessions` row records the payer identity and the exact rulepack version +
  checksum used (it already stores `rulepack_version` / `rulepack_checksum`).

### 4. Schema / migration changes

- `017_audit_session_payer.sql`:
  `ALTER TABLE audit_sessions ADD COLUMN payer_id UUID REFERENCES payers(id)`,
  `ADD COLUMN payer_slug TEXT` (immutable snapshot of the slug at audit time). Optional index on
  `(payer_id)`. Backfill existing sessions to the SHA payer.
- `018_backfill_claim_payer.sql` (the slice-1 follow-up): `UPDATE claims SET payer_id = <sha id>
  WHERE payer_id IS NULL`, then a subsequent migration tightens `claims.payer_id` to `NOT NULL`
  with a default of the SHA payer once backfill is verified.

### 5. API contract changes

- `POST /v1/claims`: accepts optional `payerId`; response claim includes `payerId` / `payerSlug` /
  `payerName`. Unknown or non-`ACTIVE` payer → `400 VALIDATION_ERROR`.
- `GET /v1/claims` and `GET /v1/claims/:id`: include payer fields.
- `POST /v1/claims/batch-audit`: optional `filter.payerId`; audits each claim against its own payer.
- Audit reads (`GET /v1/audits/:id`, `GET /v1/claims/:id/audit/latest`): include `payerId` /
  `payerSlug` alongside the existing `rulepackVersion` / `rulepackChecksum`.

### 6. Test plan

- **Unit — registry**: same engine instance returned per slug (caching); SHA resolves the flat
  layout (constructed with `payerSlug` undefined); distinct engines per payer; a payer with no
  `rulepackVersion` throws (fail closed).
- **Unit — claim-service**: stores `payer_id`; defaults to SHA when omitted; rejects a
  `COMING_SOON` / unknown payer.
- **Integration (Postgres)**:
  - Create claim with an explicit `ACTIVE` payer → `payer_id` persisted; create without payer →
    SHA default persisted.
  - Create claim with a `COMING_SOON` payer → `400`.
  - Audit a claim → `audit_sessions` row has `payer_id` / `payer_slug` and the
    `rulepack_version` / `rulepack_checksum` matching that payer.
  - Mixed-payer batch (using a fixture rulepack tree with `sha/` flat + a namespaced test payer
    under `RULEPACK_DIR`) → each session records the correct per-claim payer.
  - **Determinism**: re-auditing the same claim against the same payer/version yields identical
    `rule_results` and decision.

## Open content dependency (not an engineering task)

SHA rules were derived from official tariff PDFs in `reference-data/`. The private insurers
do not publish machine-usable adjudication rules openly. Building each payer's rulepack
requires authoritative source documents (and likely partnership/contractual access). The
catalog lists these payers as `COMING_SOON` until their rulepacks are authored.

Publicly available starting points found during research (brochures, provider panels, and
claim forms — useful for field structure and preauthorization rules, not full tariffs):

- **AAR Insurance Kenya** — Individual & Family Medical Plan brochure
  (https://cactus.co.ke/downloads/Individual_and_Family_Medical_Plan.pdf), Business/SME plan
  brochure (https://cactus.co.ke/downloads/AAR_Business_Medical_Plan_SME_Brochure.pdf).
- **Jubilee Health Insurance** — J-Care policy document
  (https://digital.jubileeinsurance.com/documents/health/jinue_policy_document.pdf),
  J-Care Johari policy document
  (https://digital.jubileeinsurance.com/documents/health/jcare_johari_policy_document.pdf),
  Johari provider panel
  (https://digital.jubileeinsurance.com/documents/health/jcare_johari_provider_panel.pdf).
  Note: inpatient treatment is subject to preauthorization; scheduled admissions ≥ 48h prior.
- **CIC Insurance Group** — Corporate provider panel (2025)
  (https://ke.cicinsurancegroup.com/wp-content/uploads/2025/09/Corporate-Provider-Panel-Updated-2025.pdf),
  CoopCare provider panel
  (https://ke.cicinsurancegroup.com/wp-content/uploads/2025/04/COOPCARE-PROVIDER-PANEL-2025.pdf),
  CIC medical claim form
  (https://nilecapital.co.ke/wp-content/uploads/2021/08/CIC-MEDICAL-Claim-Form.pdf).

These are public marketing/network documents. Authoritative tariffs and adjudication rules
should come from the insurers directly; place sourced documents under `reference-data/<payer>/`.
