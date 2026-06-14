# ClaimFlow — Data Handling & Compliance (SCAFFOLD)

> **Status: SCAFFOLD — technical sections are authoritative; legal sections are placeholders.**
>
> This document describes how ClaimFlow handles data, the technical controls in
> place, and where compliance obligations are met. Sections marked
> **`TODO (LEGAL — Jesse/DPO)`** require authoritative legal text and **must not be
> drafted by engineering**. They are intentionally left as placeholders pending
> review by Jesse and a qualified data-protection officer / legal counsel under the
> Kenya **Data Protection Act, 2019** (and, where relevant, POPIA and the SHA/SHIF
> regulatory framework). Do not treat the placeholders as legal advice or as a
> completed DPIA.

---

## 1. System context (factual)

ClaimFlow is an **on-prem**, deterministic SHA claims-documentation audit platform
deployed **inside each hospital's own infrastructure**. It verifies claim
documentation for completeness/consistency/validity/tariff-correctness **before**
submission to the national AfyaLink HIE.

- **Deployment model:** single-tenant-per-hospital install (modular monolith,
  Docker, one shared PostgreSQL 17 database). Data does **not** leave the hospital
  except via the explicit, operator-initiated submission to AfyaLink and the
  optional, governed control-plane sync (see §6).
- **The only outbound network boundary inside the product** is the API → ML-service
  HTTP call, which is **internal** to the deployment (enforced in production config:
  `ML_SERVICE_URL` must not be loopback/localhost — it points at the internal
  ml-service container, not the public internet).

## 2. Categories of data processed (factual)

| Category | Examples | Where stored | Sensitivity |
|---|---|---|---|
| Patient identifiers | `patient_sha_id`, `patient_name_enc`, `patient_national_id_enc` | `claims` table (name/national-id columns are encryption-bearing) | **PHI / sensitive personal data** |
| Clinical data | diagnosis codes (ICD-11), claim lines, services, documents (PDFs/images) | `claims`, `claim_lines`, `documents`, `document_pages`, `extracted_fields` | **PHI** |
| Facility / provider data | facility registry codes, tariffs | `facilities`, `payers`, tariff tables | Business |
| Account / auth data | user emails, password hashes (bcrypt), MFA secrets, API keys (hashed), OAuth client secrets (hashed) | `users`, `mfa_devices`, `api_keys`, `oauth_clients` | Sensitive (credentials) |
| Audit / activity | who did what, when; audit sessions; rule outcomes | `audit_trail`, `audit_user_actions`, `audit_sessions` | Sensitive (accountability) |
| Operational metering | per-tenant/per-key request counts | `usage_counters`, `usage_drops` | Business |

> Engineering note: detection internals (deterministic scores, ML quality scores,
> fix-report markdown) are **system-internal** and are never returned by the public
> API (enforced by the OpenAPI drift check + SDK no-internals test). They live in
> the engine/DB/logs only.

## 3. Technical controls (factual — authoritative)

These are implemented and enforced in code/CI today:

- **Tenant isolation:** every domain table carries `tenant_id`; PostgreSQL
  **Row-Level Security** is `ENABLE`d **and `FORCE`d** with `USING`/`WITH CHECK`
  policies on every tenant table. Application queries run as a non-superuser
  (`claimflow_app`) role that binds `app.current_tenant` per transaction;
  `app.current_tenant_id()` returns NULL on unset/empty/invalid → **fail-closed**.
  A CI meta-test (`rls-guard`) fails the build if any tenant table lacks
  `ENABLE+FORCE+policy`.
- **Audit immutability:** `audit_trail` and related accountability tables are
  **append-only** (see §4) — proven by an automated test.
- **Credentials at rest:** passwords via bcrypt; API keys and OAuth client secrets
  stored only as SHA-256 hashes (plaintext shown once at creation); MFA via TOTP.
- **Auth:** in-app JWT RS256 + TOTP MFA; per-tenant + per-principal rate limiting.
- **PII-safe logging:** user/PII-bearing log fields are routed through a sanitizer
  (`logging/sanitizer.ts`); structured JSON logs.
- **No real PHI in the codebase:** a CI guard (see §5) scans tests, fixtures, and
  the sandbox seed for real-PHI patterns and fails the build on a hit; sandbox data
  is clearly synthetic (`SANDBOX-…`).
- **Retention & purge:** configurable retention with an audited purge job (see §4).

## 4. Audit immutability & retention (factual — authoritative)

- **Immutability:** the `audit_trail` table is append-only at **three layers** —
  (1) a database trigger (`prevent_audit_trail_modification`, migration `008`)
  raises on every `UPDATE`/`DELETE`, (2) RLS policies (migration `024`) grant only
  `SELECT`/`INSERT`, and (3) the app role has `UPDATE`/`DELETE` revoked at the
  privilege level (migration `023`). Proven by `rls-isolation.integration.test.ts`
  which asserts every mutation is rejected.
- **The retention purge NEVER deletes from `audit_trail`.** The trigger is
  absolute; the purge job only deletes from **operational tables**
  (`idempotency_keys` past their `expires_at`/retention floor, terminal
  `claim_batches`/`claim_batch_items` past retention). It writes **one
  immutable `audit_trail` row per tenant per cycle** with
  `action='RETENTION_PURGE_RUN'` and a `detail_json` carrying the retention
  windows, cutoff timestamps, and per-category deletion counts — so the deletions
  are themselves auditable, and the audit log's append-only guarantee is intact.
- **Retention configuration** (operator-set via env; see `packages/api/src/config.ts`):
  - `RETENTION_INTERVAL_MS` (default `3_600_000` = 1h; set `0` to disable).
  - `IDEMPOTENCY_KEY_RETENTION_HOURS` (default `24`).
  - `CLAIM_BATCH_RETENTION_DAYS` (default `90`).
  The cycle is a `setInterval` on the privileged pool (same pattern as the
  webhook dispatcher) so it spans tenants per run.
- **`TODO (LEGAL — Jesse/DPO):` the actual retention *periods*** (how many days/years
  each data category must be kept, and the minimum/maximum mandated by SHA/SHIF
  rules and the Data Protection Act) are a legal determination. Engineering ships
  the configurable defaults above as **non-authoritative placeholders**; legal
  must confirm the binding values before production.

## 5. No-PHI-in-repo guarantee (factual — authoritative)

A CI check (`scripts/check-no-phi.sh`, run as part of CI) scans tests, fixtures,
seed/sandbox scripts, and sample payloads for patterns resembling **real** Kenyan
PHI (e.g. national ID numbers, real-looking patient names not prefixed with a
synthetic marker). Synthetic data must use the established markers (`SANDBOX-`,
`TEST-`, `TRAINING-`, `Training Patient`, `SANDBOX Test Patient`). Any suspected
real value fails the build. See the script header for the exact patterns and the
allowlist of synthetic markers.

## 6. Control-plane sync & data minimisation (factual)

The optional sync-agent uploads metrics/license/rulepack-sync data to a control
plane **only** under an operator-chosen governance mode
(`METRICS_ONLY | DEIDENTIFIED | FULL_ANALYTICS`). Default posture is the most
restrictive. **`TODO (LEGAL — Jesse/DPO):`** confirm which governance mode is
contractually permitted per deployment and document the data-sharing basis.

---

## 7. Legal & regulatory sections — PLACEHOLDERS (do not draft in engineering)

The following sections require authoritative legal text. They are listed so the
document structure is complete; the content is **deliberately omitted**.

- **7.1 Lawful basis for processing** — `TODO (LEGAL — Jesse/DPO)`
- **7.2 Data subject rights & how they are exercised** — `TODO (LEGAL — Jesse/DPO)`
- **7.3 Retention periods (binding values per data category)** — `TODO (LEGAL — Jesse/DPO)`
- **7.4 Data Processing Agreement (DPA) / processor–controller terms** — `TODO (LEGAL — Jesse/DPO)`
- **7.5 Cross-border transfer position (POPIA / others, if applicable)** — `TODO (LEGAL — Jesse/DPO)`
- **7.6 Breach notification procedure & timelines** — `TODO (LEGAL — Jesse/DPO)`
- **7.7 DPIA (Data Protection Impact Assessment) sign-off** — `TODO (LEGAL — Jesse/DPO)`
- **7.8 Registration with the Office of the Data Protection Commissioner (Kenya)** — `TODO (LEGAL — Jesse/DPO)`

> Engineering provides the technical facts (§§1–6) to support these determinations
> but does not author the legal positions in §7.
