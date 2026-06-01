# Per-tenant Rate Limiting & Usage Metering — Design (item 6d)

> **Status: IMPLEMENTED.** Migration `025` + `services/metering-service.ts` +
> `plugins/usage-metering.ts` + the `/metrics` token gate realize this. This doc
> is the rationale of record, including the RLS / decision-2 self-attestation.

## What 6d adds
- **Per-tenant** request budgets (human/JWT traffic) and **per-API-key / per-OAuth-client**
  budgets (machine traffic), enforced as a `429` with `Retry-After` + `X-RateLimit-*` headers.
- **Usage metering** — a durable per-(tenant, principal, window, route-class) counter that doubles
  as the **billing/metering source of truth**.
- Optional per-tenant / per-principal **limit overrides** (`rate_limit_policies`).

This is layered **on top of** the existing coarse global per-IP limiter (`plugins/rate-limit.ts`),
which stays as a pre-auth DoS floor. 6d runs **after** authentication, so it can key on tenant + key.

## Decision-2 (RLS) self-attestation — where quota is read and usage is written
6d reopens the decision-2 question (does the request path read/write per-tenant data, and on which
role?). **Answer: counters and quotas are tenant-scoped Postgres tables under the same RLS model as
every other tenant table, and all request-path reads/writes go through the `claimflow_app` role under
RLS — never a privileged cross-tenant path.**

- **Where:** the `usage-metering` plugin's `preHandler`. It is registered **after** `tenantPlugin`,
  so by the time it runs the request's tenant is already bound into the AsyncLocalStorage context.
- **Which pool/role:** it uses `getTenantDb()` → the app-role pool, so both the quota read
  (`rate_limit_policies`) and the usage write (`usage_counters`) execute with `app.current_tenant`
  set, confined by RLS to the current tenant. No `getPrivilegedPool` on this path.
- **Tables:** `usage_counters` and `rate_limit_policies` (migration `025`) carry `tenant_id`, have
  `ENABLE + FORCE ROW LEVEL SECURITY` with the standard `USING/WITH CHECK (tenant_id =
  app.current_tenant_id())` policy, and are granted to `claimflow_app`. They are therefore **picked
  up automatically by `rls-guard`** (which now also covers SELECT-only tenant tables — see below).

## Counter store & isolation
- **Store:** Postgres (the stack has no Redis). Counters live in `usage_counters`, keyed by
  `(tenant_id, principal_id, route_class, window_start)` — fixed 1-minute windows.
- **Isolation:** RLS confines every read/write to the current tenant; the composite PK keeps a
  tenant's principals (and the human/`'-'` principal) on separate rows. Cross-tenant counter access
  is impossible on the app role (proven by `usage-metering` per-tenant-isolation test + `rls-guard`).

## Concurrency correctness
The counter is bumped with a **single atomic statement**:
```sql
INSERT INTO usage_counters (...) VALUES (..., 1)
ON CONFLICT (tenant_id, principal_id, route_class, window_start)
DO UPDATE SET request_count = usage_counters.request_count + 1
RETURNING request_count;
```
This is a row-atomic upsert: parallel requests in the same window each get a distinct, monotonic
post-increment value via `RETURNING` — **no read-modify-write race, no double-count, no lost-count.**
Proven two ways: a raw 50-parallel psql increment → exactly 50, and a `usage-metering` integration
test firing 20 concurrent requests against a budget of 5 → exactly 5 × `200` and 15 × `429`, with the
counter landing on 20 (every request metered once).

## Limit resolution
`resolveLimit(tenant, principal, routeClass, fallback)`: a per-principal `rate_limit_policies` row
wins; else a tenant-wide (`principal_id IS NULL`) row; else the config default
(`API_KEY_RATE_LIMIT_RPM` for machine traffic, `TENANT_RATE_LIMIT_RPM` for human traffic).

## Availability: LOUD fail-open
Metering/limiting is **best-effort**. If the counter store errors, the plugin **fails open** (allows)
— a transient DB blip must not 500 every request. The fail-open is **not silent**:
- **Metric:** `claimflow_metering_fail_open_total` (Prometheus counter at `/metrics`) increments on
  every fail-open, so a counter-store outage or a bypass probe is alertable, not invisible.
- **Structured log:** a `warn` with `event: 'metering_fail_open'`, `tenantId`, `principalId`, `route`.
- **Dropped-usage record:** the unmetered request is recorded in `usage_drops` (migration `026`),
  keyed `(tenant_id, principal_id, route_class, window_start)` with an atomic `dropped_count`
  increment, so usage that went unmetered during the outage is **measurable for billing
  reconciliation** later. This write uses the **privileged pool** — the tenant-scoped path is exactly
  what just failed, so re-using it would likely fail too. `usage_drops` carries `tenant_id` as
  telemetry data (not an RLS scope), holds only counts (no PHI), is never read on the request path,
  and is **not** granted to the app role (same disposition as `outbox_events`/`sync_events`). The
  drop write is itself best-effort (never throws).

### Why fail-open is safe here — abuse-control analysis
None of the 6d limits is a **sole** abuse control, so fail-open is the right default:
- **DoS / volumetric abuse** is covered by the coarse **global per-IP limiter** (`plugins/rate-limit.ts`,
  in-memory, runs pre-auth) — independent of the Postgres counter store, so it keeps working during a
  store outage. Auth-endpoint abuse has its own tighter per-route limit (20/min on `/v1/auth/*`).
- **Authn/authz** is the real gate on a compromised credential: a leaked API key / OAuth client is
  bounded by its **explicit scopes** and its **tenant** (RLS), and is independently **revocable**
  (6a/6b). Revoking the key — not the rate limit — is the response to compromise.
- The 6d per-tenant/per-key limits are therefore genuinely **soft budgets** (fair-use + the billing
  signal), not the last line of defense. For a soft budget, the **fixed-window boundary burst** (up to
  ~2× the limit across a window edge) is acceptable, and availability > strict enforcement.

If a future limit ever becomes the *sole* control against a compromised key (e.g. a hard
spend/quota cap with no scope/revocation backstop), **that specific limit must fail _closed_** — the
metering service is structured so a per-route-class policy could opt into fail-closed without changing
the shared path. No such limit exists today.

## /metrics hardening (the flagged concern)
`GET /metrics` serves **cross-tenant aggregate counts** (no per-tenant rows, no PHI) on the privileged
pool, and was unauthenticated. It is now gated by `METRICS_AUTH_TOKEN`: when set, a matching
`Authorization: Bearer` is required (constant-time compare); when unset (dev) it stays open. Folded
into 6d rather than deferred. Per-tenant metering data is **not** exposed by `/metrics`; surfacing
billing/usage to tenants is an item-7/8 concern.

## 6c follow-up (rls-guard coverage)
`rls-guard` previously only checked tables the app role can **INSERT** into. It now **also** checks
every table with a `tenant_id` column the app role can **SELECT** — so a future SELECT-only tenant
table (e.g. a reporting view materialized as a table) without ENABLE+FORCE+policy fails CI.

## Tests
- `usage-metering.integration.test.ts` (runs the app under `APP_DATABASE_URL` as the real
  `claimflow_app` role): headers present; `429` past budget; **concurrency** (20→5/15, counter 20);
  per-tenant isolation; per-principal policy override; public paths not metered.
- `server.test.ts`: `/metrics` token gate (401 without/with wrong token, 200 with token; stays open
  when unset).
- `rls-guard.integration.test.ts`: the new SELECT-coverage assertion automatically covers
  `usage_counters` / `rate_limit_policies`.
