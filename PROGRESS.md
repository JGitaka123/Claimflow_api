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
| 1 | Async `POST /v1/claims/batch` (bulk submit + score) | ✅ done | #17 (merged) |
| 1f | Batch durability + rate-limit amplification fixes | ✅ done | #18 (merged) |
| 8 | Developer experience: SDKs + rendered docs + sandbox (from openapi.yaml) | ✅ done | #19 (merged) |
| 9 | Compliance scaffolding (audit-log immutability, retention, no-PHI-in-CI, data-handling docs) | ✅ done | #20 (merged) |
| 7 | Observability + ops (log context, anomaly counters, ready-probe, tenant usage view, Prometheus alerts) | 🟡 implemented — auto-merge eligible | _this PR_ |

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

## Slice 1f — Batch durability + rate-limit amplification (this PR, STOP GATE)
Fast-follow from the post-#17 review (3 facts checked; #3 metering-of-successes was already correct):
- **Durability/resumability:** the worker now processes only still-`QUEUED` items (read from the DB),
  so a crash/expiry + pg-boss retry RESUMES (no re-scoring, no double-metering); terminal status +
  `processed_count` are recomputed from the rows, so a batch always converges (no `PROCESSING`
  black hole). Enqueue sets `retryLimit:5 + retryBackoff + expireInMinutes:30`. `GET batch-status`
  surfaces `stalled:true` (+ `updatedAt`) when a non-terminal batch has been idle past a threshold.
- **Rate-limit amplification:** the request-path limiter charges **one unit per claim** for
  `POST /v1/claims/batch` (a metering `weight`), so a 200-claim batch costs 200 against the
  per-minute ceiling — consistent across single + bulk, not 1.
- Tests: resumability (only the QUEUED item scored, others untouched, terminal convergence, only the
  new claim metered); weighted-limit (3-claim submit → +3 on the `default` counter); stalled flag.
- Rebased onto current main (post-#19); SDK types regenerated to pick up the new `updatedAt`/`stalled`
  spec fields so the drift check stays green.

## Slice 8 — SDKs + rendered docs + sandbox (#19, merged)
Everything is **generated from `docs/openapi.yaml`** (the source of truth) with local, offline
tooling — no network calls and no LLM at generation or runtime. Design: `docs/sdk-generation-design.md`.
- **Node/TS SDK** (`packages/sdk-node`, `@claimflow/sdk-node`): `src/generated/types.ts` from
  `openapi-typescript` (pinned, lockfile-deterministic); thin hand-written `ClaimFlowClient` (API-key +
  OAuth2 client-credentials with token caching, `Idempotency-Key` helper, typed `ClaimFlowError` that
  parses **both** problem+json and the `{errors,meta}` envelope). New pnpm workspace member.
- **Python SDK** (`sdks/python/claimflow`): `models.py` (pydantic v2) from `datamodel-code-generator`
  (pinned `0.61.0`, `--formatters builtin` → reproducible, no black/isort variance); thin
  `requests`-based `ClaimFlowClient` mirroring the TS ergonomics.
- **Rendered docs** (`docs/api/index.html`): vendored `redoc.standalone.js` + spec inlined as JSON —
  fully self-contained, opens offline, **zero external calls** (no CDN, no Google Fonts).
- **Regenerable guarantee:** `scripts/generate-sdks.sh` regenerates all three; `--check` re-runs +
  `git diff --exit-code` so SDK/doc drift from the spec fails CI. New `sdk-drift` CI job (Node + Python).
- **No-internals enforcement (hard rule):** a test asserts the generated artifacts declare none of the
  three system internals (`deterministicScore`/`mlQualityScore`/`fixReportMd`) as fields and reference
  no `/internal` path, while the closed `ClaimScoreResult`/`AuditSummary` types remain present — proof
  the leak can't reappear via the SDK layer. (Downstream of the spec's own no-leakage drift check.)
- **Sandbox (synthetic data ONLY):** `scripts/seed-sandbox.sh` (idempotent, validated against a
  migrated DB) seeds a `sandbox` tenant + facility + owner, one API key + one OAuth client (fixed,
  clearly-synthetic credentials), and 5 `SANDBOX-…` claims — no real PHI. `docs/sandbox-quickstart.md`
  walks token/key → score → batch → poll in both SDKs + raw curl.
- Tests: Node SDK 11 (client behaviour: auth headers, idempotency, OAuth caching, both error shapes;
  + no-internals); Python SDK 6 (same surface). Full gate green: typecheck all; sdk-node 11; rule-engine
  300; shared 6; sync-agent 10; api 47 (+112 integration skipped without DB).
- **Merge classification:** additive (new packages/generated artifacts/docs/seed script; no change to
  auth/tenant-isolation/rate-limiting/PHI/migrations) → auto-merge eligible once CI is green. **EXCEPT
  publishing to PyPI/npm, which is a STOP GATE — built and presented; you publish.**

## Slice 9 — Compliance scaffolding (this PR)
- **Audit-log immutability:** `audit_trail` is already enforced at three layers
  (DB trigger from `008` + RLS policy from `024` + privilege REVOKE from `023`) and proven by
  `rls-isolation` (`audit_trail is append-only: insert allowed, update/delete denied`). The retention
  job is designed AROUND this — it NEVER deletes from `audit_trail`; it writes INTO it.
- **Configurable retention + audited purge job** (`services/retention-service.ts`, wired as a
  `setInterval` on the privileged pool in `JobQueue` — same pattern as the webhook dispatcher):
  - Purges only **operational** tables: expired `idempotency_keys`, terminal `claim_batches`/items
    older than retention. The audit log is never touched.
  - Writes **one immutable `audit_trail` row per tenant per cycle** with `action='RETENTION_PURGE_RUN'`
    and per-category counts + cutoffs + retention windows in `detail_json` — purges are themselves auditable.
  - Configurable via env: `RETENTION_INTERVAL_MS` (default 1h; `0` disables), `IDEMPOTENCY_KEY_RETENTION_HOURS`
    (default 24), `CLAIM_BATCH_RETENTION_DAYS` (default 90). **Defaults are non-authoritative placeholders.**
  - Migration `029` extends the `audit_action` enum with `RETENTION_PURGE_RUN`.
- **No-PHI-in-CI guard** (`scripts/check-no-phi.sh`, new `no-phi` CI job): scans tests/fixtures/seeds for
  Kenyan-shaped PHI (mobile +254/07, SHA `CR\d{9}`, bare 8-digit national IDs), allowlisting established
  synthetic markers and obvious placeholders (sequential / repeated-digit / UUID-shaped) and excluding
  UUID-embedded 8-digit hex segments. Verified positive: catches real-looking `+254712555432` and `24681357`;
  verified negative: passes on the entire current tree (98 files).
- **Data-handling docs** (`docs/data-handling.md`): technical sections (data categories, controls,
  immutability + retention mechanism, no-PHI guarantee, control-plane sync) are authoritative. **All
  legal substance — lawful basis, binding retention periods, DPA, POPIA/cross-border, breach procedure,
  DPIA sign-off, ODPC registration — left as explicit `TODO (LEGAL — Jesse/DPO)` placeholders.**
- Tests: 3 new retention integration tests (per-tenant idempotency-key purge + per-tenant audit row;
  terminal-batch retention with cascade; no-op cycle writes no audit row). API integration suite green
  at 162 tests; typecheck all green.
- **Merge classification:** additive (new service, new operational-table purge, new CI guard, new
  enum value, new docs). Does NOT modify the immutable `audit_trail` mechanism (008's trigger is
  unchanged), tenant isolation, auth, rate-limiting, or PHI handling → auto-merge eligible once CI
  is green. **STOP GATE: legal text in `docs/data-handling.md` §7 — engineering does not draft it;
  Jesse + DPO must.**

## Slice 7 — Observability + ops (this PR)
The brief: structured logging, tracing, health/readiness, dashboards/SLOs on 6d/6e metering,
alert on `claimflow_metering_fail_open_total` and auth/RLS anomalies. Tenant-facing usage views
must go through the app role under RLS; `usage_drops` is owner-only and any tenant-facing read
of it must filter by `tenant_id` explicitly.
- **Structured logging context** (`packages/api/src/logging/context.ts` + pino `mixin` in
  `server.ts`): a separate AsyncLocalStorage (deliberately NOT touching the security-critical
  tenant-binding store in `db/client.ts`). The tenant plugin enters BOTH stores at the same hook,
  so every pino line emitted during a request automatically carries `requestId` / `tenantId` /
  `userId` / `principalId` / `principalKind` (`jwt` | `api_key` | `oauth_client`) — no per-call
  threading required.
- **Real `/health/ready`** — pings the privileged pool with a bounded `SELECT 1` and returns 503
  with `{ status:'not_ready', checks:{ db:'fail' } }` on failure. `/health` stays a cheap liveness
  probe (no I/O).
- **Anomaly counters** at `/metrics`:
  - `claimflow_auth_failures_total{kind}` — labels `password|mfa|api_key|oauth_client|locked`.
    Bumped at each existing failure site (auth-service routes for password/locked/mfa, auth
    plugin for API-key/OAuth-client). No audit_trail spam — counters only.
  - `claimflow_rls_denials_total` — incremented by the error handler when the Postgres error
    matches `row-level security|new row violates row-level security|permission denied for
    (table|relation)`. Any non-zero rate is alert-worthy.
- **Cross-service request-id propagation** (`integrations/ml-client.ts`): outbound ML requests
  carry `x-request-id` sourced from the log context — minimal correlation across the only network
  boundary in the system, without an OpenTelemetry runtime.
- **Tenant-facing `GET /v1/usage`** (`routes/usage.ts`): the calling tenant's own metering view
  (counters + drops, last 24h). `usage_counters` is read via the **app role under RLS**
  (`getTenantDb`); `usage_drops` is owner-only so the query is **explicitly filtered by
  `tenant_id = $current`** per the brief's rule. The cross-tenant `/metrics` aggregate stays
  gated by `METRICS_AUTH_TOKEN`.
- **Prometheus alert rules** (`ops/prometheus/alerts.yaml`): committed config that ops scrapes;
  covers the brief's required alerts (RLS denial, auth-failure spike, metering fail-open) plus
  DB down, outbox backlog, queue failures, and a p95-latency SLO. No Grafana dashboard JSON
  shipped (deferred — ops team owns dashboard UX).
- openapi.yaml gains `/v1/usage` (drift check green); SDKs regenerated.
- Tests: 4 new log-context unit tests; 4 new observability tests (new counters in /metrics
  payload, `api_key` failure bumps counter on bad key, `/health/ready` 503 on broken DB,
  `/health` still 200). Full gate green: typecheck all; new tests +8; existing suite unchanged.
- **Merge classification:** additive — new logging helper, new counters, new readiness check,
  new tenant-facing route, new ops config. No change to auth, tenant isolation, rate-limiting,
  PHI handling, or migrations → auto-merge eligible once CI is green.

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
