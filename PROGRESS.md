# ClaimFlow — Backlog Progress

Tracking the multi-payer + public-API build. One PR per slice; each lands behind green CI
(typecheck, workspace tests, API integration on Postgres, web E2E).

Status legend: ✅ done · 🟡 in progress · ⛔ blocked · ⬜ not started

| # | Item | Status | PR |
|---|------|--------|----|
| 1a | Payer-catalog foundation (Phase 1, slice 1) | ✅ done | [#1](https://github.com/JGitaka123/Claimflow_api/pull/1) (merged) |
| 1b | Multi-payer threading (Phase 1, slice 2) | ✅ done | #2 (merged) |
| 2 | Foundation follow-ups: backfill SHA `payer_id`, tighten to `NOT NULL` | ✅ done | #3 → landed via #8 |
| 3 | Scoring endpoint (`POST /v1/claims/score`, FHIR input, reason codes, problem+json) | ✅ done | #4 → landed via #8 |
| 4 | Async + batch + signed webhooks | ✅ webhooks done | #5 → landed via #8 — async `/batch` = follow-up |
| 5 | Case management API | ✅ done | #6 → landed via #8 |
| 6a | Tenant-scoped API keys (machine auth) | ✅ done | #7 (merged) |
| 6b | OAuth2 client-credentials | ✅ done | #9 (merged) |
| 6c | Postgres Row-Level Security | ✅ done | #11 (merged) |
| 6d | Per-tenant + per-key rate limiting & metering | ✅ done | #12 (merged) |
| 6e | Loud fail-open (metering observability) | ✅ done | #13 (merged) |
| OAS | OpenAPI 3.1 spec + drift-catching CI check | ✅ done | #14 (merged) |
| OAS-A | Error-format consistency (problem+json for integrators) | ✅ done | #15 (merged) |
| OAS-B | Audit-detail leak — field-level split | ✅ done | #16 (merged) |
| 1 | Async `POST /v1/claims/batch` (bulk submit + score) | 🟡 implemented (STOP GATE) — awaiting your merge | _this PR_ |
| 8 | Developer experience: SDKs + rendered docs + sandbox (from openapi.yaml) | ⬜ next | — |
| 9 | Compliance scaffolding (audit-log immutability, retention, no-PHI-in-CI, data-handling docs) | ⬜ not started | — |
| 7 | Observability + ops (dashboards/SLOs on 6d/6e) | ⬜ not started | — |

## Slice 1 — Async `POST /v1/claims/batch` (this PR, STOP GATE)
- `POST /v1/claims/batch` (≤200 FHIR claims; `claim:create`; `Idempotency-Key`) → **202** `{ batchId, … }`;
  scores each claim async. `GET /v1/claims/batch/:batchId` → per-claim status + the **closed**
  `ClaimScoreResult` (no internals). problem+json for machine callers (inherited).
- Migration `028`: `claim_batches` + `claim_batch_items`, tenant-scoped under **ENABLE+FORCE RLS**
  (auto-covered by `rls-guard`); composite FK keeps an item's tenant from diverging from its batch.
- Worker (`process-claim-batch`) runs under `runWithTenant` (app role, RLS); **per-item try/catch** —
  one malformed claim → that item `FAILED`, batch `COMPLETED_WITH_ERRORS`, never fails the batch.
  Each scored claim counts toward **6d usage metering** (route class `batch`). `claim.flagged` fires
  per scored claim via the existing score path.
- openapi.yaml updated (drift check green); tests: 202+id, async completion, partial failure,
  no-internals, idempotent replay (one batch), max-size 400, tenant isolation 404, metering increment.
- STOP GATE: new RLS tables + metering → human-merge, not auto-merge.

## Cross-cutting follow-ups / debts

- **OpenAPI 3.1 spec** does not exist in the repo yet. The operating rules require it as the
  source of truth with a CI sync check. Scheduled with item 8 (developer experience); flagged
  here so it isn't lost. Items 3–5 should be designed spec-first once it exists.
- **Backfill + `payer_id NOT NULL`** (item 2) is the immediate next slice.

## Slice notes

### 1b — Multi-payer threading (in review)
- `payerId` accepted on `POST /v1/claims` (optional; defaults to SHA). Fails closed (400) on
  unknown or non-ACTIVE payers.
- Claim reads (`GET /v1/claims`, `GET /v1/claims/:id`) include `payerId` / `payerSlug` / `payerName`.
- Per-payer `RuleEngine` registry (`rule-engine-registry.ts`): one engine per slug, lazily
  created + cached; SHA uses the flat rulepack layout, others namespaced; fail-closed when a
  payer has no rulepack version.
- Audit pipeline resolves each claim's payer before any ML work and records `payer_id` /
  `payer_slug` on the `audit_sessions` row (migration `017`), alongside rulepack version +
  checksum — immutable, reproducible audit trail.
- `POST /v1/claims/batch-audit` gains an optional `filter.payerId`; mixed-payer batches audit
  each claim against its own payer.
- Tests: registry unit tests; `payer-threading` integration (default/explicit/COMING_SOON/
  unknown payer + detail reads); audit-session payer-recording assertion.

### 2 — Payer foundation follow-ups (in review, stacked on 1b)
- Migration `018`: backfill claims with NULL `payer_id` to SHA, then `claims.payer_id SET NOT NULL`
  (safe path — backfill before constraint; API always sets it; reversible).
- Updated direct claim inserts (rbac + state-machine integration tests, `seed-test-data.sh`) to
  set the SHA payer, since the column is now mandatory.
- Test: asserts `claims.payer_id` is `NOT NULL` via `information_schema`.

> Stacked on `claude/slice-2-payer-threading` because `NOT NULL` is only safe once slice 2's
> create path (which always sets `payer_id`) is in place. PR base will be retargeted to `main`
> after 1b merges.

### 3 — Scoring endpoint (in review, stacked on item 2)
- `POST /v1/claims/score`: accepts a FHIR R4 Claim subset, persists a claim (reusing
  `claim-service`: payer resolution, dedup, idempotency, audit trail) + a document-less audit
  session, returns a public-safe score.
- Public output: `riskScore` / `riskLevel` / `recommendedAction` / `flags[]` (reasonCode,
  category, severity, message) / `counts`. **No rule internals** (thresholds, logic keys, params,
  evidence) — enforced by a test.
- Reason codes: ClaimFlow taxonomy (`CF-<ruleId>`); `auditorGeneralTypology` is `null` until the
  authoritative list is supplied (decision: build now / map later).
- Errors: RFC 7807 `application/problem+json`, scoped to public endpoints only.
- Fail-closed on non-ACTIVE payer; idempotent via `Idempotency-Key`.
- Tests: mapper unit tests + integration (score/persist/no-internals, problem+json, fail-closed,
  invalid FHIR, idempotent replay).
- **Follow-up (blocked):** Auditor-General typology mapping needs the authoritative typology list
  (see STOP GATE below). List-endpoint pagination/filtering already satisfied by the claims list.

### Data needed (blocking a follow-up, not the endpoint)
- **SHA Auditor-General fraud/error typology list** (codes + names, ideally a finding→typology
  mapping). Drop in `reference-data/`. Until then `auditorGeneralTypology` stays `null`; the
  scoring endpoint is fully functional with ClaimFlow reason codes.

### 4 — Signed webhooks (in review, stacked)
- `webhook_endpoints` + `webhook_deliveries` (migration `019`); tenant-scoped endpoint CRUD at
  `/v1/webhooks` (+ `/:id/deliveries` log). Signing secret returned once on create.
- HMAC-SHA256 Stripe-style signatures (`X-ClaimFlow-Signature: t=…,v1=…`) + `verifyWebhookSignature`
  helper; stale-timestamp + tamper rejection.
- Delivery decoupled from pg-boss: emission inserts signed PENDING rows; a dispatcher delivers due
  rows with exponential backoff via `next_attempt_at` (FAILED → retry, then EXHAUSTED). Injectable
  sender → deterministic tests. A periodic in-process dispatcher runs the cycle.
- `claim.flagged` emitted from the audit pipeline (single audit, batch, and structured scoring) when
  the decision is not PASSED; payload is public-safe (no rule internals).
- Tests: signing unit tests; integration for CRUD (secret hidden on list), signed delivery + verify,
  backoff on failure, and emission via the score endpoint.
- **Follow-up:** async `POST /v1/claims/batch` submission endpoint; `case.status_changed` with item 5.

### 5 — Case management (in review, stacked)
- `investigation_cases` + `case_claims` (many-to-many) + append-only `case_events` (migration `020`).
- `/v1/cases` CRUD + status transitions (state-machine validated) + claim link/unlink; every mutation
  writes a `case_events` row (immutable case audit trail).
- `case.status_changed` emitted into the item-4 webhook system on transition.
- New RBAC permissions `case:view` / `case:manage` (supervisor, auditor, admin, super_admin).
- Tests: transition unit + integration (create/link/events, 422 on invalid transition, webhook
  emission, link/unlink, tenant isolation).

### 6 — Auth & tenancy (decisions resolved; building in sub-slices)
Decisions: **API keys + OAuth2**, **shared schema + Postgres RLS**, **per-tenant + per-API-key**
limits/metering. See `docs/auth-and-tenancy-design.md`.
- **6a — tenant-scoped API keys (in review):** `api_keys` table (migration `021`, sha-256 hash only,
  scopes, expiry, revoke); `/v1/api-keys` CRUD (secret returned once); auth plugin accepts a
  `cf_`-prefixed key via `X-Api-Key` or `Bearer` and authorizes by scopes (least privilege; JWT path
  unchanged). Tests: create/list(secret hidden)/revoke, auth-via-key, scope enforcement,
  revoked/expired/unknown rejection.
- **6b — OAuth2 client-credentials (this PR, stacked on #7):** `oauth_clients` table (migration `022`,
  sha-256 secret hash only, scopes, revoke); public `POST /v1/oauth/token`
  (`grant_type=client_credentials`, RFC 6749 §4.4; form-encoded + JSON) issues a short-lived **RS256
  JWT** (dedicated `claimflow-oauth` audience, `tenant` + space-delimited `scope` claims) reusing the
  existing keypair; supports down-scoping; constant-time, fail-closed credential check. Auth plugin
  verifies `type:'oauth_client'` Bearer JWTs and authorizes **by scope** (like API keys; never a role).
  `/v1/oauth/clients` admin CRUD (`system:settings`, secret once). problem+json on the token endpoint.
  Tests: 8 integration cases (create/list/revoke, token issuance + authenticated request, scope
  enforcement, JSON+form, down-scope, scope-not-granted, bad credentials, revoked client, bad grant).
- **6c — Postgres RLS backstop (this PR, STOP GATE):** design in `docs/rls-design.md` (PR #10).
  Migrations `023` (non-superuser `claimflow_app` role + least-privilege grants; denormalized
  `tenant_id` on hot child tables with composite FKs so a child can't diverge from its parent;
  `idempotency_keys` tenant scoping + composite PK; tenant-leading indexes) and `024` (ENABLE+FORCE
  RLS + `FOR ALL` USING/WITH CHECK policies on every tenant table; EXISTS-join policies on leaf
  tables; append-only audit_trail/case_events; `app.current_tenant_id()` returns NULL on
  unset/empty/invalid → fail-closed). App layer: a two-pool model in `db/client.ts` — tenant code
  reaches the DB only via `getTenantDb()` (binds `app.current_tenant` with SET LOCAL per
  transaction, sourced from an AsyncLocalStorage context set in the tenant plugin); cross-tenant
  pre-context paths use `getPrivilegedPool()` (allowlisted); migration/test harnesses use
  `getAdminPool()`. CI guards: a meta-test fails if any app-writable table lacks ENABLE+FORCE+policy,
  plus a static import guard restricting the privileged/admin pools. Tests: `rls-isolation`
  (as the real `claimflow_app` role — cross-tenant read/write denied, fail-closed on unset/empty,
  append-only proven, globals readable) + `rls-guard`. Full gate green: typecheck all; API 134;
  rule-engine 300; shared 6.
- **6d — per-tenant + per-key rate limiting & usage metering (this PR, STOP GATE):** migration `025`
  adds `usage_counters` (metering/billing source) + `rate_limit_policies` (per-tenant/per-principal
  limit overrides), both **tenant-scoped under the same ENABLE+FORCE RLS model** and picked up by
  `rls-guard`. A `usage-metering` preHandler — running **after** the tenant plugin binds the context —
  reads quota + records usage on the **claimflow_app role under RLS** (`getTenantDb`, no privileged
  cross-tenant access on the request path). Atomic `INSERT … ON CONFLICT … DO UPDATE SET count =
  count + 1 RETURNING` → correct under concurrency (no double/lost count; proven by a 20-parallel test
  → exactly 5 allowed, counter = 20). Per-tenant (JWT) and per-API-key/OAuth principal budgets;
  `429` + `Retry-After` + `X-RateLimit-*` headers; problem+json on public endpoints inherited.
  **Fails open** on a counter-store error (availability > strict metering; the coarse global per-IP
  limiter remains the DoS floor). `/metrics` (cross-tenant aggregate, privileged pool) now gated by
  `METRICS_AUTH_TOKEN` when set. 6c follow-up: `rls-guard` extended to any `tenant_id`-bearing table
  the app role can **SELECT** (not just writable). Tests: `usage-metering` (headers, 429, concurrency,
  per-tenant isolation, policy override, public-path skip) + metrics-auth + extended rls-guard.

### STOP GATES (per the merge policy — I build, you merge)
OAuth2/identity, Postgres RLS, rate-limiting/quota, anything gating/handling PHI, destructive/breaking
migrations, and the first OpenAPI spec publication all require your explicit merge.
- **6a (#7) + 6b (this PR)** are machine **auth/identity** → built, CI-gated, **awaiting your merge**.
  Per the "never more than 2 unmerged stacked" rule, I am **pausing after 6b** rather than stacking
  6c/6d on an unmerged tower. Merge #7 then 6b (in order) and I'll proceed to 6c (RLS).
