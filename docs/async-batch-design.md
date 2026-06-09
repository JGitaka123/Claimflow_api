# Slice 1 — Async `POST /v1/claims/batch` (bulk submit + score)

## Goal
Accept a batch of FHIR claims, return a **batch id immediately** (202), and score
each claim asynchronously. Per-claim results surface via (a) the existing
`claim.flagged` webhook and (b) a new `GET /v1/claims/batch/:batchId` status
endpoint. Distinct from the existing `POST /v1/claims/batch-audit`, which audits
*existing* claims; this submits *new* claims (the bulk analogue of `/v1/claims/score`).

## Contract
- **`POST /v1/claims/batch`** — `{ claims: ScoreClaimRequest[] }`, max `MAX_CLAIMS_PER_BATCH`
  (200). Permission `claim:create` (already a machine scope → integrators can call it).
  `Idempotency-Key` header (replay returns the same batch id). → **202** `{ batchId,
  status, totalClaims, createdAt }`.
- **`GET /v1/claims/batch/:batchId`** — `{ batchId, status, totalClaims, processedCount,
  items: [{ index, status: QUEUED|SCORED|FAILED, claimId?, score?, error? }] }`.
  Permission `claim:create`. Tenant-scoped (RLS); 404 cross-tenant.
- Errors: problem+json for machine callers (already global, keyed on `request.apiKey`).
- Scoring output per item is the **closed** `ClaimScoreResult` (no internals) — reuses
  the score path, so the no-leakage guarantee is inherited.

## Persistence (tenant-scoped, under RLS) — migration `028`
- `claim_batches` (batch header): `id, tenant_id, status, total_claims, processed_count,
  created_by, created_at, updated_at`. RLS ENABLE+FORCE + the standard policy; granted
  to `claimflow_app`. Picked up by `rls-guard`.
- `claim_batch_items` (per-claim): `id, batch_id, tenant_id, item_index, status,
  claim_id, score_json (closed ClaimScoreResult), error_code, error_message,
  created_at, updated_at`. Composite FK `(batch_id, tenant_id) → claim_batches(id,
  tenant_id)` so an item can't diverge from its batch's tenant. RLS likewise.
  `score_json` stores ONLY the closed public score (no internals).
- Idempotency: reuse `idempotency_keys` (already tenant-scoped) — the submit endpoint
  stores the 202 batch response under the key, like `/v1/claims`.

## Flow
1. **Submit (request path, app role under RLS):** validate; enforce max size; create
   the `claim_batches` row + N `claim_batch_items` (status QUEUED) in one tx; enqueue a
   single pg-boss `process-claim-batch` job carrying `{ batchId, tenantId,
   requestedByUserId }`. Return 202.
2. **Worker (`runWithTenant(tenantId, …)`):** load the batch's items; for each, score
   it via the scoring service inside its own try/catch so **one malformed claim fails
   only its item** (status FAILED + error_code/message), never the batch. On success:
   item → SCORED, persist the closed score, claim_id; the `claim.flagged` webhook fires
   from the score path as today. Bump `processed_count`. When all items terminal →
   batch status COMPLETED (or COMPLETED_WITH_ERRORS if any FAILED).
3. **Metering:** each scored claim counts toward 6d usage — the worker calls the
   metering `recordAndCheck` once per item (route class `batch`), on the app role under
   RLS, so bulk submissions meter per claim (not per HTTP request). Over-budget items
   are still recorded (soft budget; metering is the billing signal, not a hard stop in
   the worker — the submit endpoint itself is rate-limited by the request-path limiter).

## Partial failure
Each item is scored independently; a malformed FHIR claim or a non-ACTIVE payer yields
that item's `FAILED` + a problem-style `error_code`/`error_message`, while siblings
proceed. Batch terminal status reflects whether any item failed.

## OpenAPI + tests
- Add both paths + `BatchSubmitRequest` / `EnvelopeBatchAccepted` / `BatchStatus`
  (with closed `ClaimScoreResult` per item) to `openapi.yaml`; drift check enforces.
- Integration tests: submit returns 202 + batch id; status transitions QUEUED→terminal;
  a mixed batch (one malformed claim) → that item FAILED, others SCORED, batch
  COMPLETED_WITH_ERRORS; idempotent re-submit returns same batch id; max-size 400;
  tenant isolation (cross-tenant GET → 404); per-item score carries no internals;
  metering counter increments per scored claim. Synthetic claims only.

## Safety classification
New tables (028) are **additive** + tenant-scoped under RLS (not destructive/breaking).
New endpoints are additive. BUT the slice touches **tenant-isolation (new RLS tables)
and metering** — per the merge policy that makes it a **human-merge STOP GATE**, not
auto-merge. Build, green CI, open PR, pause for merge.
