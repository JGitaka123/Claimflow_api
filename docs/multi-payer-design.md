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
