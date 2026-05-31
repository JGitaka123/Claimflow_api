# Webhooks Design — signed event delivery

> Backlog item 4 (webhook portion). Status: **in progress.** Plan lands before implementation.

## Purpose

Let tenants subscribe HTTPS endpoints to ClaimFlow events and receive **HMAC-signed**,
**retried** deliveries with a durable **delivery log**. First event: `claim.flagged` (emitted when
an audit/score decision is not `PASSED`). `case.status_changed` is added with the case-management
slice (item 5).

## Data model (migration `019_webhooks.sql`)

- `webhook_endpoints` (tenant-scoped): `id, tenant_id, url, secret, events text[], is_active,
  description, created_at, updated_at`. `secret` is a generated signing key, returned **once** at
  creation and never again.
- `webhook_deliveries` (the durable log): `id, tenant_id, endpoint_id, event_type, event_id,
  payload_json, status (PENDING|DELIVERED|FAILED|EXHAUSTED), attempts, max_attempts,
  response_status, error, next_attempt_at, created_at, delivered_at`.

## Signing

`X-ClaimFlow-Signature: t=<unix>,v1=<hex>` where `hex = HMAC_SHA256(secret, "<t>.<rawBody>")`
(Stripe-style). Receivers recompute and compare in constant time, rejecting stale timestamps
(default tolerance 5 min). A `verifyWebhookSignature()` helper ships for consumers/tests.

## Delivery (decoupled from the pipeline)

- **Emission** only inserts signed `PENDING` delivery rows (`next_attempt_at = now()`) for each
  active endpoint subscribed to the event. This needs only a DB handle, so the audit pipeline can
  emit without depending on the job queue.
- A **dispatcher** (`dispatchDueDeliveries`) claims due rows (`PENDING`/`FAILED`,
  `next_attempt_at <= now`, `attempts < max_attempts`), POSTs them, and records the outcome:
  - success → `DELIVERED`;
  - failure → `attempts++`, `next_attempt_at = now + backoff(attempts)` (exponential: 1m, 2m, 4m,
    …, capped), `FAILED`; once `attempts >= max_attempts` → `EXHAUSTED`.
  The HTTP sender is injectable, so the dispatcher is unit/integration-tested deterministically.
- A pg-boss recurring worker runs the dispatcher periodically in production.

## Emission points

`claim.flagged` is emitted from the audit pipeline after a session is persisted when the decision
is `FAILED` or `WARNING` — covering single audits, batch audits, and structured scoring. Payload is
**public-safe** (claimId, auditId, payerSlug, decision, riskLevel, counts) — no rule internals.

## API

- `POST /v1/webhooks` — register `{ url, events[], description? }`; returns the endpoint incl. the
  signing `secret` (once).
- `GET /v1/webhooks` — list endpoints (no secret).
- `DELETE /v1/webhooks/:id` — remove an endpoint.
- `GET /v1/webhooks/:id/deliveries` — recent deliveries (the log) for debugging.

All tenant-scoped and permissioned (`system:settings`).

## Tests

- Unit: sign/verify round-trip; tampered body / stale timestamp rejected; backoff schedule.
- Integration: register endpoint; emit event → PENDING deliveries created (signed); dispatcher with
  an injected sender marks DELIVERED on success and schedules backoff / EXHAUSTED on failure; a
  flagged score creates a `claim.flagged` delivery. Synthetic data only.

## Follow-ups

- `POST /v1/claims/batch` async submission endpoint (item 4 tail) — async batch already exists via
  `batch-audit`; the new endpoint is additive.
- `case.status_changed` event with item 5.
