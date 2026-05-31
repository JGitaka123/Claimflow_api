# Case Management Design

> Backlog item 5. Status: **implemented.**

## Purpose

Investigation cases group flagged claims for review, carry a status lifecycle, and record every
mutation in an append-only audit trail. Emits `case.status_changed` into the item-4 webhook system.

## Data model (migration `020_cases.sql`)

- `investigation_cases` (tenant-scoped): `title, description, status, priority, assigned_to,
  resolution, created_by, timestamps, closed_at`.
- `case_claims`: many-to-many link between cases and claims (a case groups multiple flagged claims).
- `case_events`: **append-only** audit trail of every case mutation (`CASE_CREATED`,
  `CASE_UPDATED`, `CASE_STATUS_CHANGED`, `CASE_CLAIMS_LINKED`, `CASE_CLAIM_UNLINKED`).

## Status lifecycle

`OPEN → INVESTIGATING → {ON_HOLD ↔ INVESTIGATING, RESOLVED}`, `RESOLVED → {CLOSED, INVESTIGATING}`,
any non-terminal → `DISMISSED`. `CLOSED`/`DISMISSED` are terminal (set `closed_at`). Transitions are
validated by `isValidCaseTransition` (shared); invalid → `422 INVALID_STATE_TRANSITION`. The
validator is unit-tested independently of the DB.

## API (`/v1/cases`)

- `POST /v1/cases` — create (optionally linking claims).
- `GET /v1/cases` — list (filter by status / assignee).
- `GET /v1/cases/:id` — detail incl. linked claims + event trail.
- `PATCH /v1/cases/:id` — update title/description/priority/assignee/resolution.
- `POST /v1/cases/:id/transition` — status change (validated) → emits `case.status_changed`.
- `POST /v1/cases/:id/claims` / `DELETE /v1/cases/:id/claims/:claimId` — link/unlink claims.

RBAC: `case:view` (read) / `case:manage` (mutate), granted to supervisor, auditor, admin,
super_admin. All queries tenant-scoped; cross-tenant access returns 404.

## Integrity

- Every mutation is wrapped in a transaction with a `case_events` row — the immutable case trail.
- Linked claims are validated to belong to the tenant (fail closed, 400 otherwise).
- `case.status_changed` webhook payload is public-safe (`caseId`, `fromStatus`, `toStatus`).

## Tests

- Unit: transition state machine.
- Integration: create + link + `CASE_CREATED` event; transition state-machine enforcement
  (invalid → 422); `case.status_changed` delivered to a subscribed endpoint; link/unlink; tenant
  isolation (cross-tenant GET → 404).
