# Postgres Row-Level Security — Design (item 6c)

> **Status: APPROVED + IMPLEMENTED.** Migrations `023`/`024` + the two-pool app
> layer (`db/client.ts`, `db/privileged.ts`), CI guards, and the `rls-isolation` /
> `rls-guard` suites realize this design. This document remains the rationale of
> record; see the implementation PR for the code.
> This is the defense-in-depth backstop for tenant isolation decided in
> `docs/auth-and-tenancy-design.md` (item 6: *shared schema + Postgres RLS*).
> Application-level scoping (the `tenant` plugin + `WHERE tenant_id = $1` in every
> query) already exists; RLS makes a missing/incorrect app-level filter unable to
> leak across tenants at the **database** level. RLS is the seatbelt, not the
> steering — both stay.

This doc presents options + a recommendation for each area you asked about and
**stops for your review**. Nothing here is wired up until you approve.

---

## 0. Current state (what the code does today)

Facts gathered from the codebase, because they drive every decision below:

- **Connection model:** a single shared `pg.Pool` (`db/client.ts`, `min 5 / max 20`).
  Services run queries **two ways**:
  1. `this.pool.query(sql, params)` — borrows an arbitrary pooled connection for a
     single statement and returns it. The **vast majority** of reads/writes.
  2. `withTransaction(pool, cb)` — `pool.connect()` → `BEGIN … COMMIT` → `release()`.
     Used by `claim-service`, `case-service`, `auth-service`, `document-service`,
     `extraction-service`, `preauthorization-service`, `state-machine`.
- **Tenant context** is established per request by the `tenant` plugin
  (`request.tenant.tenantId`, derived from the verified token) and passed into
  services as a `tenantId` **function argument**. It is *not* attached to the DB
  connection in any way today.
- **Background work without a request:** pg-boss workers (`jobs/setup.ts`,
  `jobs/handlers/batch-audit.ts`) and the webhook dispatcher operate with **no
  request tenant context** — they carry the tenant in the job payload / row data.
- **DB role:** the app connects via `DATABASE_URL`, today almost certainly the DB
  **owner/superuser**. Migrations run through `scripts/migrate.sh` using the same
  `DATABASE_URL` and raw `psql`. No non-privileged role exists yet.

The single most important consequence: **because most queries use `pool.query()`
(one statement, connection returned immediately), any tenant context we attach
must live for exactly one statement or one transaction — never at the session
level.** This is the pooling-leak risk, addressed head-on in §1.

---

## 1. How tenant context reaches the database (the pooling-leak crux)

We need every tenant-scoped statement to run with the current tenant known to
Postgres, via `current_setting('app.current_tenant')` referenced by the policies.
The question is *how* that GUC gets set without bleeding across the pool.

### The leak risk, stated explicitly
A pooled connection is reused by unrelated requests. If we set the GUC at **session
scope** — `SET app.current_tenant = '…'` or `set_config(…, false)` (the `false` =
not-local form) — the value **persists on that physical connection after the request
ends**. The next request to borrow that connection inherits the previous tenant's
ID until it happens to overwrite it. A request that forgets to set it (a new code
path, an error between borrow and set) reads/writes **another tenant's data**. This
is the classic RLS-with-pgbouncer/pg-pool footgun and is unacceptable for PHI.

`SET LOCAL` / `set_config(…, true)` scope the value to the **current transaction
only**; Postgres resets it automatically at COMMIT/ROLLBACK. It cannot outlive the
transaction, so it cannot bleed across pooled reuse — **provided every statement
that relies on it runs inside a transaction.**

### Options

**Option A — `SET LOCAL` inside an explicit transaction, via a mandatory
`withTenant(tenantId, cb)` helper.**
Wrap every tenant-scoped unit of work in a transaction that first issues
`SELECT set_config('app.current_tenant', $1, true)` (the `true` = LOCAL), then runs
the work on that same `client`. The existing `withTransaction` helpers become
`withTenantTransaction`. Single-statement `pool.query()` calls that touch
tenant-scoped tables are migrated to run through this helper (they become a
one-statement transaction — cheap).
- ✅ Leak-proof by construction: value dies with the transaction.
- ✅ Works with any pooler (pg-pool today, pgbouncer transaction-mode later).
- ✅ Explicit and greppable; easy to test.
- ⚠️ Requires routing today's bare `pool.query()` calls through the helper. This is
  mechanical but touches every service. It is the bulk of the 6c implementation work.

**Option B — session GUC set on connection checkout (`pool.on('acquire')` / per-request `SET`).**
Set `app.current_tenant` at session scope when a connection is borrowed, reset on release.
- ❌ Bleeds if reset is ever missed (error paths, crashes, early returns). Fragile.
- ❌ Breaks under transaction-mode poolers (the session spans many tenants).
- ❌ A connection used by two awaited operations interleaved in one request can race.
- Rejected: this is exactly the leak you flagged.

**Option C — `SET LOCAL` but rely on the *existing* `withTransaction` only, leaving
bare `pool.query()` calls unprotected.**
- ❌ The bare single-statement reads (most list/get endpoints) would run with **no**
  tenant GUC set → under a fail-closed policy they return **zero rows** (breaking
  every read), or under a permissive policy they leak. Not viable without §5's
  fail-closed default making it a hard outage. Rejected.

### Recommendation — **Option A.**
A `withTenant(tenantId, cb)` that opens a transaction, sets `app.current_tenant`
with `set_config(…, true)`, and hands the bound `client` to the callback. Every
tenant-scoped DB access — single statement or multi-statement — goes through it.
Reference/global tables (§3) may still use bare `pool.query()` since no policy gates
them. This is more upfront refactoring but it is the only design that is *leak-proof
regardless of pooler*, which is the entire point of adding RLS.

**Background workers (no request):** the worker resolves the tenant from the job
payload / row (e.g. `batch-audit` already has the claim's tenant) and calls the
**same** `withTenant(tenantId, cb)`. A worker that processes multiple tenants in one
run opens one `withTenant` block per tenant. No session-level state.

**Connection cost note:** turning bare reads into one-statement transactions adds a
BEGIN/COMMIT round-trip. With `max 20` local pooling this is negligible; called out
so it's a conscious tradeoff, not a surprise in the perf benchmark (`pnpm perf:api`).

---

## 2. FORCE RLS, the application DB role, and the privileged migration path

### Options for the role model

**Option A — dedicated non-superuser, non-BYPASSRLS app role + `FORCE ROW LEVEL
SECURITY`; migrations/admin run as the owner.**
- Create `claimflow_app` (LOGIN, no SUPERUSER, no BYPASSRLS, not the table owner).
  The API connects as this role.
- `ALTER TABLE … ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY` on
  every tenant-scoped table. `FORCE` matters because the table **owner is normally
  exempt from RLS**; without `FORCE`, anything connecting as the owner (or a
  superuser) silently bypasses every policy. `FORCE` makes the policies apply even
  to the owner — so even a misconfigured connection string can't quietly bypass.
- Migrations and admin/break-glass tasks connect as the **owner** (`claimflow_owner`
  / current `DATABASE_URL`) over a **separate** connection string. DDL stays on the
  privileged path; the runtime app role gets only `SELECT/INSERT/UPDATE/DELETE` on
  the tables it needs (and `USAGE` on sequences), never DDL.
- ✅ Defense in depth: the runtime credential literally cannot see another tenant,
  and cannot turn RLS off (only the owner/superuser can `ALTER TABLE … DISABLE`).
- ✅ Clean split: `DATABASE_URL` (owner, migrations) vs a new `APP_DATABASE_URL`
  (app role, runtime).
- ⚠️ Adds a role + grants migration and a second connection string to config/ops.

**Option B — enable RLS but keep connecting as the owner, no FORCE.**
- ❌ Owner bypasses RLS unless FORCED; so this is *RLS in name only* — the app (as
  owner) ignores every policy. Provides zero real backstop. Rejected.

**Option C — one role, FORCE RLS, app role also owns tables.**
- ❌ If the app role owns the tables it can `ALTER TABLE … DISABLE ROW LEVEL
  SECURITY` or drop policies at runtime — the backstop is self-defeating. Ownership
  must stay on a role the runtime does not use. Rejected.

### Recommendation — **Option A.**
- Roles: `claimflow_owner` (owns schema, runs migrations; current `DATABASE_URL`) and
  `claimflow_app` (runtime; **new** `APP_DATABASE_URL`, `NOSUPERUSER NOBYPASSRLS`,
  table-level DML grants only).
- `ENABLE` + **`FORCE`** RLS on every §3 tenant-scoped table.
- A new migration creates the role + grants + RLS; a follow-up ops note documents
  setting `APP_DATABASE_URL`. `config.ts` gains `APP_DATABASE_URL` (falls back to
  `DATABASE_URL` in dev/test so nothing breaks before ops provisions the role —
  with a startup warning when it falls back in production).
- **Migrations/admin:** unchanged path (`scripts/migrate.sh`, owner). Break-glass
  cross-tenant reporting, if ever needed, uses the owner connection explicitly and
  is audit-logged — never the app role.

> Decision to confirm: introducing a second DB role + `APP_DATABASE_URL` is the
> "right" way but touches deployment/ops (docker-compose, `.env.example`, runbooks).
> Alternative is to ship policies + FORCE now and the role split as a fast follow.
> My recommendation is to do them **together** (a half-done role split gives a false
> sense of safety), but I'm flagging it as the main scope decision for your call.

---

## 3. Exact table inventory — scoped vs. global

Derived by scanning all 22 migrations. **Authoritative list for the policy migration.**

### A. Tenant-scoped — own `tenant_id` column → direct RLS policy keyed on it
| Table | Notes |
|---|---|
| `facilities` | `tenant_id` |
| `users` | `tenant_id` |
| `claims` | `tenant_id` |
| `audit_trail` | `tenant_id` — **immutable audit log** (see §5) |
| `preauthorizations` | `tenant_id` |
| `webhook_endpoints` | `tenant_id` |
| `webhook_deliveries` | `tenant_id` |
| `investigation_cases` | `tenant_id` |
| `case_claims` | `tenant_id` |
| `case_events` | `tenant_id` |
| `api_keys` | `tenant_id` (item 6a) |
| `oauth_clients` | `tenant_id` (item 6b) |

### B. Tenant-scoped by inheritance — **no** `tenant_id`, belong to a tenant via FK
These must still be isolated. Two policy strategies (see §4): add a `tenant_id`
column (denormalize) **or** policy via an `EXISTS` join to the parent.
| Table | Tenant reached via |
|---|---|
| `claim_lines` | → `claims` |
| `audit_sessions` | → `claims` |
| `rule_results` | → `audit_sessions` → `claims` |
| `documents` | → `claims` |
| `document_pages` | → `documents` → `claims` |
| `ocr_text` | → `documents` → `claims` |
| `extracted_fields` | → `claims` (also `documents`) |
| `corrections` | → `extracted_fields` → `claims` |
| `mfa_devices` | → `users` |
| `refresh_tokens` | → `users` |
| `preauthorization_service_codes` | → `preauthorizations` |

### C. Global reference / catalog — **must NOT be RLS-restricted** (world-readable to the app role)
Shared across all tenants; every hospital audits against the same data. RLS here
would break audits for everyone.
| Table | Why global |
|---|---|
| `payers` | global payer catalog (multi-payer foundation) |
| `icd_codes` | ICD-11 reference |
| `sha_service_codes` | SHA tariff service codes |
| `tariffs`, `tariff_versions` | SHA tariff reference |
| `rulepacks`, `rulepack_rules` | versioned rule definitions (not tenant data) |
| `schema_migrations` | migration ledger |

> These already match the integration-test truncation allow-list
> (`payers, icd_codes, sha_service_codes` are preserved across truncations),
> confirming they're treated as catalog data today.

### D. Needs an explicit decision (no `tenant_id`, not obviously global)
| Table | Question | Recommendation |
|---|---|---|
| `idempotency_keys` | PK is the key; no tenant column. Could a key collide across tenants and leak a cached response body? | **Add `tenant_id`** and scope it. Idempotency replay returning another tenant's cached `response_body` would be a cross-tenant PHI leak. This is the one place I'd treat as a latent bug RLS surfaces. |
| `outbox_events` | aggregate-based, no tenant column; written by app, drained by worker | Scope by adding `tenant_id` (worker sets tenant per drain) **or** keep owner-only (worker runs as owner). Lean: keep **owner/worker-only**, not exposed to the app role, simplest and the worker already runs privileged. |
| `registry_cache` | external registry lookups cached globally | **Global** (like reference data) — keep unrestricted. |
| `sync_events` | control-plane sync ledger, facility/instance-level | **Owner/worker-only**, not app-role exposed. |
| `license_state` | keyed by `facility_id`, not tenant | Scope via `facilities` join, **or** treat as owner-managed. Lean: **owner-managed** (licensing is an ops concern, not request-path tenant data). |
| `tenants` | the tenant root; `id` *is* the tenant | Policy `id = current_tenant` for the app role (a tenant may read its own row); owner manages provisioning. |

These D-table calls are itemized so you can veto any before code.

#### Access-path audit (resolves the held `outbox_events` / `license_state` question)
Traced every reference across all packages, migrations, and the Python service:
- **`outbox_events`** — **no `INSERT` anywhere** (the transactional-outbox table from migration
  010 was never wired up; event emission actually goes through the item-4 `webhook_*` tables).
  The only read is `routes/metrics.ts` (`count(*) WHERE published = false`) for a Prometheus gauge;
  `/metrics` is in the auth + tenant plugins' public-path sets → **no tenant context, cross-tenant
  by design**. → confirmed **owner/worker-only**; not on the synchronous app-role request path.
- **`license_state`** — the only writer is `packages/sync-agent/src/license-validator.ts`, a
  **separate process** (not the Fastify app). **No** API route/service/plugin reads it or any
  per-tenant quota. → confirmed **owner-managed**; not on the app-role request path.
- Consequence: neither needs a scoped app policy. The one interaction to handle is that the
  cross-tenant `/metrics` reader must run on the **privileged (owner/BYPASSRLS) pool**, not the
  tenant-scoped app pool — otherwise fail-closed RLS would silently zero its gauges. The metrics
  collector is therefore on the privileged allowlist (it reads only aggregate counts, no PHI rows).

---

## 4. Policy design per operation (incl. `WITH CHECK`)

For an **A-table** (own `tenant_id`), the policy set is:

```
-- pseudocode / illustrative, NOT applied yet
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE ROW LEVEL SECURITY;

CREATE POLICY claims_tenant_isolation ON claims
  USING      (tenant_id = current_setting('app.current_tenant')::uuid)   -- read/visibility (SELECT/UPDATE/DELETE)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);  -- write guard (INSERT/UPDATE)
```

- **`USING`** filters which existing rows are visible to SELECT/UPDATE/DELETE — a
  row whose `tenant_id` ≠ the GUC is invisible (so it can't be read, updated, or
  deleted).
- **`WITH CHECK`** validates the *new* row image on INSERT/UPDATE — a write whose
  `tenant_id` ≠ the GUC is **rejected**, so a request can never write a row stamped
  with a foreign tenant (or flip an existing row to another tenant on UPDATE). This
  directly answers "a row can never be written with a foreign `tenant_id`."
- Use a **single `FOR ALL` policy** with both clauses per table (simplest, covers
  all four ops) rather than four per-command policies, unless a table needs
  asymmetric rules (audit_trail does — §5).

**Options for B-tables (no `tenant_id`):**

**Option B1 — denormalize: add a `tenant_id` column to each B-table, backfill from
the parent, then identical simple policies.**
- ✅ Policies are simple equality checks (fast, index-friendly, same shape as A).
- ✅ `WITH CHECK` on these tables directly prevents writing a child under a foreign
  parent.
- ⚠️ Schema change + backfill on 11 tables; app inserts must set `tenant_id`
  (mostly already in scope via the tenant context).

**Option B2 — `EXISTS` join policy to the parent, no schema change.**
```
USING (EXISTS (SELECT 1 FROM claims c
               WHERE c.id = claim_lines.claim_id
                 AND c.tenant_id = current_setting('app.current_tenant')::uuid))
```
- ✅ No schema/backfill churn.
- ⚠️ Sub-select per row-group; with the parent's `tenant_id` index it's fine, but
  deep chains (`corrections → extracted_fields → claims`) nest joins.
- ⚠️ `WITH CHECK` for INSERT still works via the same EXISTS against the parent.

### Recommendation — **hybrid:**
- **B1 (add `tenant_id`)** for the high-traffic, directly-queried children:
  `claim_lines`, `audit_sessions`, `rule_results`, `documents`, `extracted_fields`.
  These are on hot read paths and benefit from index-backed equality policies.
- **B2 (EXISTS)** for the leaf/low-traffic ones reached only via their parent:
  `document_pages`, `ocr_text`, `corrections`, `mfa_devices`, `refresh_tokens`,
  `preauthorization_service_codes`.
- This keeps hot paths fast without a 11-table schema churn. Final per-table
  assignment ships in the design's implementation PR for your review — calling out
  the split now so the approach is approved.

---

## 5. Fail-closed behavior + the immutable audit log

### Fail-closed when tenant context is unset
`current_setting('app.current_tenant')` on an unset GUC **raises an error** unless
called as `current_setting('app.current_tenant', true)` (the `missing_ok` form),
which returns `NULL`. Design choice:

- Policies reference `current_setting('app.current_tenant', true)::uuid`. When unset,
  the comparison `tenant_id = NULL` is `NULL` → **the row is not visible and no write
  passes `WITH CHECK`**. So an un-scoped connection sees **zero rows and can write
  nothing** — it denies, never default-allows. This is the desired fail-closed
  posture: a code path that forgets `withTenant` returns empty / errors on write,
  loudly, rather than leaking.
- We do **not** want the alternative (a policy that treats unset as "see everything"
  for admin convenience). There is no `OR current_tenant IS NULL` escape hatch in
  any app-role policy. Cross-tenant admin work uses the **owner** connection (§2),
  not a NULL-tenant bypass.
- Because most reads become one-statement `withTenant` transactions (§1), the GUC is
  always set on the paths that should see data; the fail-closed default only ever
  bites genuinely un-scoped access (a bug we *want* surfaced).

### The immutable audit log under RLS (`audit_trail`, plus `case_events`)
`audit_trail` is the append-only compliance log. Under RLS it needs:
- **Read:** `USING (tenant_id = current_tenant)` — a tenant sees only its own trail.
- **Insert:** `WITH CHECK (tenant_id = current_tenant)` — entries can only be written
  for the current tenant (no forging another tenant's history).
- **No UPDATE / no DELETE policy** for the app role → with `FORCE` RLS and **no**
  permissive policy for those commands, UPDATE/DELETE are **denied** for the app role
  even though it has table privileges. Combined with **revoking** `UPDATE,DELETE` on
  `audit_trail` from `claimflow_app` at the grant level (belt + suspenders), the log
  is **append-only at the database level** — not just by convention. This strengthens
  the existing "append-only" intent (currently enforced only in app code).
- Same treatment for the append-only `case_events` (item 5's case audit trail).
- Retention/immutability hardening (e.g. partitioning, a `REVOKE` on owner too,
  WORM storage) is **item 9** (compliance scaffolding) — 6c just ensures RLS doesn't
  weaken, and ideally strengthens, the append-only guarantee.

---

## 6. Test plan — proving isolation (cross-tenant read AND write must fail)

A new `rls.integration.test.ts` (real Postgres, like the others), plus role wiring
so tests exercise the **app role**, not the owner — otherwise FORCE-RLS exemptions
hide everything. The harness will create the `claimflow_app` role and connect the
app under it for these tests.

**Read isolation**
1. Seed tenant A and tenant B, each with a claim (+ lines, documents, audit_trail).
2. Under `withTenant(A)`: `SELECT * FROM claims` returns only A's; a direct
   `SELECT … WHERE id = <B's claim id>` (no `tenant_id` filter in SQL) returns
   **0 rows** — proves RLS blocks even a query that "forgets" the app filter.
3. Repeat for B-tables: `claim_lines`, `documents`, `audit_sessions` for B's claim
   are invisible under tenant A.

**Write isolation (the WITH CHECK proofs)**
4. Under `withTenant(A)`, `INSERT INTO claims (tenant_id, …) VALUES ('<B>', …)` →
   **rejected** by `WITH CHECK` (cannot stamp a row for another tenant).
5. Under `withTenant(A)`, `UPDATE claims SET tenant_id = '<B>' WHERE id = '<A claim>'`
   → **rejected** (cannot move a row to another tenant).
6. Under `withTenant(A)`, attempt to UPDATE/DELETE B's claim by id → **0 rows
   affected** (invisible via `USING`).
7. Under `withTenant(A)`, INSERT a `claim_line` referencing B's claim → rejected
   (B1 via `WITH CHECK`; B2 via the EXISTS check failing).

**Fail-closed proofs**
8. With **no** `withTenant` (GUC unset) on the app role: `SELECT * FROM claims` →
   **0 rows**; any INSERT → rejected. Proves unset = deny, not allow.

**Audit-log immutability proofs**
9. Under `withTenant(A)`: INSERT into `audit_trail` for A succeeds; UPDATE or DELETE
   of an `audit_trail` row → **denied** (no policy / revoked privilege).
10. INSERT into `audit_trail` stamped with B's tenant under `withTenant(A)` →
    rejected.

**Global-table proofs**
11. Under `withTenant(A)`: `SELECT` from `payers`, `icd_codes`, `sha_service_codes`
    returns rows (not RLS-blocked) — confirms reference data stays readable.

**Regression**
12. The full existing API integration suite must stay green once routed through
    `withTenant` — proves the refactor preserves behavior. (This is the real
    confidence signal that §1's connection-binding change is correct.)

---

## 7. Proposed rollout (for reference — not executed until approved)

1. Migration `023`: create `claimflow_app` role + grants; add `tenant_id` to the B1
   tables + backfill; `idempotency_keys.tenant_id`.
2. Migration `024`: `ENABLE` + `FORCE` RLS and policies on all A + B tables;
   `REVOKE UPDATE,DELETE` on `audit_trail`/`case_events` from app role.
3. App: `withTenant(tenantId, cb)` in `db/client.ts`; route services + workers
   through it; add `APP_DATABASE_URL` to config (fallback + prod warning).
4. `rls.integration.test.ts` (§6) + CI wiring to run it under the app role.
5. Docs/ops: `.env.example`, docker-compose, runbook for the two-role setup.

Sequenced so schema/role lands before policies, and policies before the app starts
depending on the GUC — each step independently testable.

---

## 8. Open decisions for your approval (blocking)

1. **Two-role split + `APP_DATABASE_URL` now, or policies+FORCE now and role split as
   a fast-follow?** (Rec: together — §2.)
2. **D-table dispositions** (§3.D): confirm `idempotency_keys` gets `tenant_id`
   (Rec: yes — latent leak); `outbox_events`/`sync_events`/`license_state` stay
   owner/worker-only (Rec: yes); `registry_cache` global (Rec: yes).
3. **B-table strategy** (§4): approve the B1/B2 hybrid split.
4. **Scope of audit-log hardening in 6c** vs deferring deeper immutability to item 9
   (Rec: 6c does RLS + append-only revokes; item 9 does retention/WORM).

On approval I'll implement 6c as a single PR (stop-gated — your merge), with the
isolation test suite as the centerpiece.
