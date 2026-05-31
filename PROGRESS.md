# ClaimFlow — Backlog Progress

Tracking the multi-payer + public-API build. One PR per slice; each lands behind green CI
(typecheck, workspace tests, API integration on Postgres, web E2E).

Status legend: ✅ done · 🟡 in progress · ⛔ blocked · ⬜ not started

| # | Item | Status | PR |
|---|------|--------|----|
| 1a | Payer-catalog foundation (Phase 1, slice 1) | ✅ done | [#1](https://github.com/JGitaka123/Claimflow_api/pull/1) (merged) |
| 1b | Multi-payer threading (Phase 1, slice 2) | 🟡 in review | _this PR_ |
| 2 | Foundation follow-ups: backfill SHA `payer_id`, tighten to `NOT NULL` | ⬜ not started | — |
| 3 | Scoring endpoint hardening (`POST /v1/claims/score`, FHIR input, reason codes, problem+json) | ⬜ not started | — |
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

### STOP GATES pending my input
- **Item 6** — default auth model (OAuth2 client-credentials vs. tenant-scoped API keys vs.
  both) and tenancy isolation strategy (shared schema + row scoping vs. schema-per-tenant vs.
  DB-per-tenant). I will pause with options + a recommendation before implementing.
