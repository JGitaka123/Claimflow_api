# OpenAPI 3.1 Contract & Drift Check — design notes

> **Status: for review (STOP GATE).** `docs/openapi.yaml` is the hand-authored
> contract for the `v1` surface; `packages/api/src/__tests__/openapi-drift.integration.test.ts`
> is the CI drift check. **No LLM and no external/network dependency is involved** —
> the spec is authored by hand and the check uses local libraries only (`yaml`,
> `ajv`, `ajv-formats`). (OpenAPI is the API-description standard; it is unrelated
> to OpenAI, and `OPENAI_KEY` is not read anywhere here.)

## How drift is detected (not just "spec exists")
The check fails the build on code↔spec divergence, three ways:

1. **Route coverage, both directions.** It builds the real server (`buildServer`)
   and captures every registered route via Fastify's `onRoute` hook, normalizes
   `:param` → `{param}`, drops auto-added `HEAD`/`OPTIONS`, and asserts the set of
   `METHOD path` pairs **equals** the set of operations declared in `openapi.yaml`.
   - A new/renamed/removed route not mirrored in the spec → **undocumented-route**
     failure.
   - A spec operation with no implementation → **phantom-spec** failure.
   This is exact set equality, so it catches additions *and* deletions on either side.

2. **Spec validity.** The document must declare `openapi: 3.1.0` and every
   component schema must compile under a JSON-Schema 2020-12 validator (3.1 is
   2020-12 aligned). A malformed schema fails CI.

3. **Payload conformance + no-leakage.** Representative response payloads are
   validated against the referenced schema with `ajv`; the scoring schemas are
   asserted **closed** (`additionalProperties: false`) and free of internal field
   names, and a payload carrying a rule internal (e.g. `threshold`) is asserted to
   be **rejected** by the compiled schema. Security schemes, the problem+json
   responses, and the `Idempotency-Key` parameter are asserted present.

**Runs in both CI jobs.** The check makes no DB connection (pools are lazy; it
only enumerates routes and parses YAML), so it runs in the no-Postgres *workspace*
job as well as the Postgres *integration* job — drift is caught on every PR.

## No detection-rule internals (enforced, not just intended)
`ClaimScoreResult` and `ScoreFlag` are `additionalProperties: false` and expose
only: `riskLevel`, `recommendedAction`, public `flags` (reasonCode + category +
severity + short message + nullable auditorGeneralTypology), and `counts`. The
drift test bans the field names `threshold(s)`, `evidence`, `ruleDefinition`,
`logic`, `params`, `weight`, `modelScore`, `rawScore` on these schemas and proves
a leaky payload is rejected. The same closed-schema discipline is applied wherever
a public response is fully modelled.

## Documented security & contract model
- **Auth schemes:** `bearerJwt` (human session), `apiKey` (`X-Api-Key` or
  `Authorization: Bearer cf_…`, authorized by scope), and `oauth2ClientCredentials`
  (token at `/v1/oauth/token`, scope-authorized). Public endpoints set `security: []`.
- **Error envelopes:** standard endpoints use `{ data, meta?, errors? }`; the public
  machine endpoints (`/v1/claims/score`, `/v1/oauth/token`) use RFC 7807
  `application/problem+json`. Both are modelled (`EnvelopeErrorBody`, `Problem`).
- **Idempotency:** `Idempotency-Key` documented on the submission endpoints
  (`POST /v1/claims`, `POST /v1/claims/score`); replays surface `x-idempotent-replay`.
- **Pagination/filtering:** cursor pagination (`cursor`, `limit`, `sortBy`,
  `sortOrder`) + filters (`status`, `claimType`, `facilityId`, `dateFrom/To`, `q`)
  on `GET /v1/claims`; `meta.cursor` / `meta.hasMore` on the response.
- **FHIR-aligned input:** `POST /v1/claims/score` takes a FHIR R4 `Claim` subset
  (`FhirClaimResource`).

## Contract quirks flagged (fixed in the contract, not enshrined)
1. **No numeric `riskScore` in the score response.** The item-3 shorthand said
   "score", but the implementation exposes a categorical `riskLevel`
   (LOW/MEDIUM/HIGH) + `recommendedAction`, deliberately **not** a raw numeric
   score (a raw score could leak model internals). The contract documents
   `riskLevel`; it does **not** invent a `riskScore`. ✅ kept clean.
2. **Generic objects for under-modelled bodies.** Several admin/dashboard/audit
   responses are returned as ad-hoc objects in code. Rather than over-specify a
   shape the code doesn't guarantee, the contract types those `data` payloads as
   open objects (`EnvelopeObject`/`EnvelopeObjectList`) and reserves tight schemas
   for the stable, public-facing resources (claims, scoring, keys, oauth, auth).
   Flagged so we can tighten these incrementally without the drift check giving a
   false sense of precision. **Not a behavior change.**
3. **`/metrics` content type.** Returns Prometheus text, not JSON, and is
   documented as such with the optional `metricsToken` scheme (matching the 6d
   `METRICS_AUTH_TOKEN` gate).

No contract entry was written to match a quirk that should instead be fixed in
code; where the implementation already had the cleaner behavior (e.g. no raw
score), the contract follows it.

## Not wired yet (per the STOP GATE)
SDK generation and rendered docs are **not** wired off this spec yet — that waits
for your review/approval of the contract.
