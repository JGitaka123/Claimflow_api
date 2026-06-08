# PR-B — Closing the audit-detail rule-internal leak

> **Status: IMPLEMENTED (final design below).** The model evolved twice in review;
> the FINAL design is a **field-level split**, summarized here first. The earlier
> credential-split and platform-staff iterations are retained further down for the
> decision trail.

## FINAL design (implemented) — field-level split
Facts established in review:
1. The first-party dashboard is operated by **tenant/hospital staff** (Claims
   Officer + Supervisor; on-prem in hospitals) — **not** ClaimFlow staff.
2. The dashboard renders **`evidence` only** (to jump to the failing field /
   document page). It **never** references `deterministicScore`, `mlQualityScore`,
   or `fixReportMd` — those were sent over the wire but displayed nowhere.
3. The four fields are **not equivalent**: `evidence` is claim-level justification a
   customer legitimately needs to action a flag; the three score/fix-report fields
   are **system internals** (detection IP) that must not reach a customer.

So the boundary is **field-level, not credential-level**:
- **`evidence` + `remediation`** stay in the single customer-facing `AuditSummary`
  (closed schema). The dashboard works on the public endpoint.
- **`deterministicScore`, `mlQualityScore`, `fixReportMd`** are **dropped from ALL
  API responses entirely** — they remain in the engine / DB / logs and never leave
  the server over the API. No `/internal` endpoint exists.
- The audit endpoints are gated by **`audit:read`**, which is **not** in the machine
  scope vocabulary, so API keys / OAuth clients (external integrators) get **403** and
  `evidence` (PHI-adjacent) never reaches a machine credential.
- `/internal` is therefore **absent from the public OpenAPI spec and SDKs** — no
  internal field names/structure are published.

This is simpler and strictly safer than the credential-split: there is no
full-detail HTTP path to leak, and the no-leakage guarantee is enforced by the
closed `AuditSummary` schema (drift test bans the three internals on every public
schema and proves a payload carrying them is rejected).

---

## Earlier iterations (decision trail — superseded)
> **Status: DESIGN — for review.** Sequenced after #15, before item 8 (SDKs).

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
- New `Permission` values: `audit:read` (projected) and `audit:read:internal` (full).
  **Neither is added to `API_KEY_SCOPES`/OAuth scopes** — Decision 3: `audit:read`
  stays **staff-only for now** (not a machine scope yet), so `AuditSummary` is a
  ready customer-facing view we can expose later by a one-line flip, not a redesign.
- The public projected endpoints switch from `requireRole(...)` to
  `requirePermission('audit:read')` so access is explicit; `audit:read` is granted
  to staff roles via `ROLE_PERMISSIONS` (claims-officer+).

### Decision 2 — REVISED during implementation: gate `/internal` on HUMAN SESSION, not platform-staff
> **What changed and why.** Implementation surfaced that the first-party web
> dashboard's audit view **consumes `evidence`** to drive its core remediation
> workflow (jump-to-failing-field / link-to-document-page). Gating `/internal` on a
> platform-staff flag would have **broken tenant staff's own dashboard**. The real
> boundary is **human tenant staff vs external integrators (machine credentials)** —
> not platform vs tenant. So `/internal` is gated by **`requireHumanSession()`**: it
> denies any request bearing `request.apiKey` (every API key / OAuth client sets it),
> while allowing interactive JWT sessions. This achieves Decision 2's *intent* — rule
> internals can never reach a credential a tenant provisions for **external
> integration** (API keys / OAuth are the only such credentials; both are denied) —
> without crippling the staff UI. The `is_platform_staff` column/flag is **not**
> introduced. `audit:read:internal` as a separate non-machine scope is replaced by the
> simpler, stronger `requireHumanSession()` guard (a machine credential can never be a
> human session, by construction).
>
> The original platform-staff analysis below is retained for context.

### Decision 2 (original) — `audit:read:internal` gated on PLATFORM STAFF, not tenant role
**Role/tenant model (verified):** every `users` row is `tenant_id`-scoped (no global
users); roles are a flat enum on the row; a **tenant admin** (`requireRole(admin) +
user:manage`, tenant-scoped) can assign `auditor`/`supervisor`/`admin` to its own
users (only `super_admin` assignment is gated, and even super_admin is created within
a tenant). **So supervisor/admin/auditor/super_admin are all tenant-assignable** — a
customer admin could mint a user holding any of them. Gating `audit:read:internal` on
any current role would therefore **re-leak** internals to the customer.

There is no platform-staff distinction today, so PR-B introduces one, independent of
tenant role:
- Migration: add **`users.is_platform_staff BOOLEAN NOT NULL DEFAULT false`**;
  surface it into the auth context / token claims.
- New guard **`requirePlatformStaff()`** authorizes purely on `is_platform_staff = true`,
  ignoring `role`. The `/internal` endpoints use `requirePlatformStaff()` (+ the
  `audit:read:internal` permission for clarity), never a role check.
- **The tenant-facing admin user create/update path never accepts or writes
  `is_platform_staff`** (the Zod bodies omit it; the SQL never sets it) — so no tenant
  admin can grant it. It is set only via a privileged/seed/ops path (e.g. a migration
  or a super-admin-platform tool), out of reach of the tenant API.
- `audit:read:internal` remains excluded from the machine-scope vocabulary, so API
  keys / OAuth clients can never hold it regardless of the flag.

Net: `/internal` (full evidence/scores/fix-report) is reachable ONLY by a ClaimFlow
platform-staff user — structurally unreachable by any tenant user (any role) and any
machine credential. The customer-facing path is the closed `AuditSummary` only.

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

## Decisions (APPROVED)
1. **Two representations** — public projected default + restricted `/internal` full. ✅
2. **`audit:read:internal` gated on a platform-staff flag, not tenant role** (the
   role/tenant model makes supervisor/admin/auditor/super_admin tenant-assignable;
   gating on them would re-leak). New `users.is_platform_staff` + `requirePlatformStaff()`.
   ✅ (see "Decision 2" above).
3. **`audit:read` stays staff-only for now** — NOT a machine scope. `AuditSummary` is
   kept as the ready, closed, customer-facing view so exposing it later is a flip. ✅

Design is final; it folds into the PR-B implementation PR (no separate doc PR).
Sequence: #15 merges → implement PR-B off main (after #15 lands; both touch
openapi.yaml) → pause for merge → item 8 (SDKs off the corrected spec).
