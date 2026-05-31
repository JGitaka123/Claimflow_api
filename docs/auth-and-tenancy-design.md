# Auth, Multi-Tenancy & Rate Limiting Design (item 6)

> Status: **in progress.** Confirmed decisions below. Implemented across focused sub-slices
> (6a → 6d) because the surface is large and RLS is cross-cutting.

## Confirmed decisions

1. **Machine auth: API keys + OAuth2 (both).** Tenant-scoped, hashed, revocable **API keys** for
   simple integrations; **OAuth2 client-credentials** (client_id/secret → short-lived scoped JWT)
   for enterprise. The existing human **JWT + MFA** dashboard auth is unchanged.
2. **Tenant isolation: shared schema + Postgres RLS.** Keep `tenant_id` row-scoping (already
   enforced by the tenant plugin + queries) and add Postgres Row-Level Security as a hard
   database-level backstop.
3. **Rate limiting + quota: per-tenant and per-API-key**, with usage counters suitable as a
   billing/metering source.

## Sub-slices (one PR each)

### 6a — Tenant-scoped API keys (this slice)
- `api_keys` table: `id, tenant_id, name, key_prefix, key_hash (sha256), scopes text[], created_by,
  last_used_at, expires_at, revoked_at, created_at`.
- Key format `cf_<prefix>_<secret>`; only the **hash** is stored. The plaintext is returned **once**
  at creation.
- Auth plugin: a `cf_`-prefixed `Authorization: Bearer` (or `X-Api-Key`) authenticates via the API
  key — resolving `tenantId` + `scopes` — alongside the existing JWT path (JWT path untouched).
- Authorization: scopes are a subset of the existing `Permission` values. `requirePermission`
  passes if the request's API-key scopes include the permission **or** the JWT role grants it.
- CRUD: `POST /v1/api-keys` (create, returns secret once), `GET /v1/api-keys` (list, no secret),
  `DELETE /v1/api-keys/:id` (revoke). Permission `system:settings`.
- `last_used_at` updated on use; expired/revoked keys rejected (fail closed).

### 6b — OAuth2 client-credentials (implemented)
- **migration `022`** — `oauth_clients` (`client_id`, **hashed** secret, `scopes`, `tenant_id`,
  `created_by`, `last_used_at`, `revoked_at`). Only the SHA-256 hash of the secret is stored.
- **shared** — `OAuthClient` / `OAuthTokenResponse` / `OAuthAccessTokenClaims` types,
  `OAUTH_CLIENT_SCOPES` (shares the API-key scope vocabulary), `CreateOAuthClientSchema` +
  `OAuthTokenRequestSchema`.
- **`POST /v1/oauth/token`** (`grant_type=client_credentials`, RFC 6749 §4.4) — public; accepts
  `application/x-www-form-urlencoded` (and JSON). Verifies the client (constant-time, fail-closed),
  supports **down-scoping** (a requested `scope` must be a subset of the grant), and issues a
  short-lived **RS256 JWT** (`type:'oauth_client'`, dedicated audience `claimflow-oauth`, `tenant` +
  space-delimited `scope` claims) reusing the existing keypair. Response is `no-store`, `Bearer`,
  with `expires_in` derived from the configured access-token TTL.
- **auth plugin** — a non-`cf_` Bearer JWT whose `type` claim is `oauth_client` is verified via
  `verifyOAuthAccessToken` and authorized **by scope** (never by a role), exactly like an API key.
  `sub` is the provisioning user (so `created_by` FKs resolve); `cid` records the issuing client.
- **admin CRUD** — `POST/GET/DELETE /v1/oauth/clients` (permission `system:settings`); secret shown
  once at creation. Revoking a client stops new tokens being minted (issued tokens are stateless and
  expire on their short TTL).
- **errors** — RFC 7807 `application/problem+json`, scoped to `/v1/oauth/token`.
- **tests** — 8 integration cases: client create (secret once) / list (hidden); token issuance +
  authenticated request; scope enforcement (in-scope 201, out-of-scope 403); JSON + form-encoded;
  down-scoping; scope-not-granted 403; invalid credentials 401; revoked client 401; unsupported
  grant 400. Synthetic data only.

### 6c — Postgres Row-Level Security
- Enable RLS on tenant-scoped tables with a policy keyed off a per-transaction GUC
  (`app.current_tenant`). Requests run their DB work with the tenant set, so a missing app-level
  `WHERE tenant_id` can no longer leak across tenants. Rolled out carefully (the pooled query path
  must set the GUC) with isolation tests; reference/catalog tables (payers, icd_codes,
  sha_service_codes) stay world-readable.

### 6d — Per-tenant + per-key rate limiting & metering
- Extend the rate-limit plugin to key on tenant + API key. Add a `usage_counters` table (per tenant,
  per key, per window/route class) as the billing/metering source. Quota enforcement returns 429
  with problem+json on public endpoints.

## Integrity / safety

- **Fail closed**: expired, revoked, or unknown keys/clients are rejected.
- **No secrets at rest in plaintext**: only hashes of API-key secrets and OAuth client secrets.
- **Least privilege**: keys/clients carry explicit scopes; a key can never exceed its tenant.
- **Backwards compatible**: the human JWT/MFA path and all existing routes/tests are unaffected;
  the API-key path activates only for `cf_`-prefixed credentials.

## Tests

- 6a: key hashing/verification unit tests; integration for create (secret once) / list (hidden) /
  revoke, authenticating a request with a key, scope enforcement, expired/revoked rejection, and
  tenant scoping.
- 6b–6d: token issuance + JWT verification; cross-tenant RLS isolation; per-key limit + quota 429.
