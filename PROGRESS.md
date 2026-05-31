# ClaimFlow — Backlog Progress

Tracking the multi-payer + public-API build. One PR per slice; each lands behind green CI
(typecheck, workspace tests, API integration on Postgres, web E2E).

Status legend: ✅ done · 🟡 in progress · ⛔ blocked · ⬜ not started

| # | Item | Status | PR |
|---|------|--------|----|
| 1a | Payer-catalog foundation (Phase 1, slice 1) | ✅ done | [#1](https://github.com/JGitaka123/Claimflow_api/pull/1) (merged) |
| 1b | Multi-payer threading (Phase 1, slice 2) | 🟡 in review | _this PR_ |
| 2 | Foundation follow-ups: backfill SHA `payer_id`, tighten to `NOT NULL` | 🟡 in review (stacked on 1b) | _stacked PR_ |
| 3 | Scoring endpoint (`POST /v1/claims/score`, FHIR input, reason codes, problem+json) | 🟡 in review (stacked) | _stacked PR_ |
| 4 | Async + batch + signed webhooks | ⬜ not started | — |
| 5 | Case management API | ⬜ not started | — |
| 6 | Multi-tenancy, auth, rate limiting | ⛔ STOP GATE (auth model + tenancy isolation decision) | — |
| 7 | Observability + ops + usage metering | ⬜ not started | — |
| 8 | Developer experience: interactive docs, sandbox, SDKs | ⬜ not started | — |
| 9 | Compliance scaffolding (audit-log immutability, retention, DPA-2019, no-PHI-in-CI) | ⬜ not started | — |

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

### STOP GATES pending my input
- **Item 6** — default auth model (OAuth2 client-credentials vs. tenant-scoped API keys vs.
  both) and tenancy isolation strategy (shared schema + row scoping vs. schema-per-tenant vs.
  DB-per-tenant). I will pause with options + a recommendation before implementing.
