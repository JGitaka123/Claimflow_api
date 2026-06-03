# PR-B — Closing the audit-detail rule-internal leak (DESIGN)

> **Status: DESIGN — for review. No implementation in this PR.** Sequenced after
> #15 (error-format consistency) merges, before item 8 (SDKs).

## The finding (from the OpenAPI open-object audit)
`GET /v1/claims/{claimId}/audit/latest` and `GET /v1/audits/{auditId}` return the
audit session **with rule internals**: per-rule `evidence`, plus session
`deterministicScore`, `mlQualityScore`, and `fixReportMd`. They are guarded by
`requireRole(CLAIMS_OFFICER_AND_ABOVE)`, and `requireRole` authorizes a **machine
credential by its creator's role** — so an API key / OAuth client created by any
claims-officer-or-above user can read full rule internals, against an **open**
schema (so the no-leakage check doesn't cover it). This is the gap.

## Decisive control: the PROJECTION, not the scope
A scope only decides *who can call*; it does not stop internals reaching an
external/tenant principal that legitimately holds the scope. So the binding
guarantee is a **closed, projected response** that physically omits the four
internal fields. The scope/role is defense-in-depth on top.

## Decision 1 — audit-detail is INTERNAL staff data, but we expose a public projection
The full detail (`evidence`, scores, `fixReportMd`) is a **staff remediation aid**
consumed by the internal dashboard; it is PHI-/detection-IP-adjacent. There is no
integrator use case for the internals (integrators use `POST /v1/claims/score`,
already public-safe). We therefore ship **two representations** (chosen over a
single endpoint that conditionally includes internals by caller — conditional
inclusion is exactly the foot-gun that caused this leak):

### (a) Public, projected, CLOSED — the default endpoints
`GET /v1/claims/{claimId}/audit/latest` and `GET /v1/audits/{auditId}` return a
**closed `AuditSummary`**: `auditId`, `claimId`, `payer`, `decision`,
`recommendedAction`, `counts`, public `findings[]` (reasonCode, category,
severity, message, `auditorGeneralTypology`), `rulepackVersion`, `createdAt`,
`completedAt`. **The four internal fields — `evidence`, `deterministicScore`,
`mlQualityScore`, `fixReportMd` — are dropped at the serialization boundary** (a
mapper returns the projected DTO; the internals never enter the public path).
`additionalProperties: false` in the schema. Reachable by staff JWT and by a
machine credential holding the new `audit:read` scope — both see only the
projection.

### (b) Internal, full detail — restricted, never integrator-reachable
`GET /v1/audits/{auditId}/internal` (+ `/v1/claims/{claimId}/audit/latest/internal`)
returns the full `AuditSessionDetail` (with `evidence`/scores/`fixReportMd`) for
the dashboard. Guarded by `requireRole(INTERNAL_AUDIT_ROLES)` **and** a new
`audit:read:internal` Permission that is **deliberately excluded from
`API_KEY_SCOPES`/`OAUTH_CLIENT_SCOPES`** — so no API key or OAuth client can ever
hold it, and the machine-auth path (`requirePermission`) can never satisfy it.
Because machine credentials are authorized by scope and this permission is not a
grantable scope, the internal endpoint is structurally unreachable by any
external/tenant integrator credential.

> Why two endpoints, not role-branching inside one: a single endpoint that returns
> internals "only for internal callers" keeps the internals on the public code path
> and one bug (a missed check) re-leaks. Separate endpoints keep internals off the
> public serializer entirely.

## Auth additions (shared)
- New `Permission` values: `audit:read` (projected; **added** to
  `API_KEY_SCOPES`/OAuth scopes so integrators can opt in to the safe view) and
  `audit:read:internal` (full; **NOT** added to the machine-scope vocabulary).
- `ROLE_PERMISSIONS`: grant `audit:read` to claims-officer+; grant
  `audit:read:internal` only to internal roles (supervisor/admin/auditor/super-admin
  — to be confirmed in review).
- The public endpoints switch from `requireRole(...)` to
  `requirePermission('audit:read')` so machine access is **explicit + scoped**, not
  an implicit role side-effect.

## OpenAPI + drift test
- `openapi.yaml`: model `AuditSummary` as a **closed** schema (public endpoints);
  the `/internal` endpoints documented as internal-only (full schema, no machine
  security scheme).
- Extend the drift **no-leakage** test: assert `AuditSummary` (and the score
  schemas) are `additionalProperties:false` and that the field names `evidence`,
  `deterministicScore`, `mlQualityScore`, `fixReportMd` appear on **no public
  schema**; compile the schema and prove a payload carrying any of the four is
  **rejected**.
- A live integration test: a machine credential with `audit:read` gets the
  projection (asserts the four fields are absent); the same credential gets
  **403** on the `/internal` endpoint (proves it can't hold `audit:read:internal`);
  an internal JWT gets full detail on `/internal`.

## Migration / compatibility note
This changes the **shape** of the existing `GET /v1/audits/:id` +
`/audit/latest` responses (internals removed). The internal web app's audit view
consumes those today, so PR-B also repoints the dashboard's audit-detail fetch to
the `/internal` endpoints. That keeps staff functionality intact while the public
endpoints become safe. (Verified the web app calls these; the repoint is part of
PR-B.)

## Open decisions for your review
1. Approve **two-representation** approach (public projected default + restricted
   `/internal` full).
2. Confirm which roles get `audit:read:internal` (proposed: supervisor, admin,
   auditor, super_admin — i.e. internal staff who today see the fix report).
3. Confirm `audit:read` (projected) is acceptable to add to the machine-scope
   vocabulary so integrators can pull the safe audit summary, or whether audit
   summaries should stay staff-only for now (then `audit:read` is role-only and no
   machine scope is added).

On approval I implement PR-B, then proceed to item 8 (SDKs off the corrected spec).
