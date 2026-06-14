# Item 8 — SDKs + rendered docs + sandbox (from openapi.yaml)

> Everything is **generated from `docs/openapi.yaml`** (the source of truth) with
> local, offline tooling — **no network calls and no LLM at generation or runtime**.
> A CI check regenerates and diffs, so the committed artifacts can't drift from the
> spec. **STOP GATE: do NOT publish to PyPI/npm — build, present, Jesse publishes.**

## Toolchain (all local, offline-capable)
- **TS types:** `openapi-typescript` (reads YAML → `.d.ts`; no network).
- **Python models:** `datamodel-code-generator` (`datamodel-codegen`) → pydantic v2.
- **Rendered docs:** `redoc` standalone bundle **vendored** from node_modules (the
  `redoc.standalone.js` file) + an HTML shell with the spec inlined as JSON. No CDN,
  no Google Fonts — fully self-contained, opens offline.
- A generator script (`scripts/generate-sdks.sh`) runs all three; CI re-runs it and
  fails if the working tree changed (drift = build red).

## Layout
```
packages/sdk-node/        @claimflow/sdk — TS SDK
  src/generated/types.ts  (generated; do not edit)
  src/client.ts           thin hand-written client (auth, idempotency, problem+json)
  src/index.ts            barrel
  package.json, tsconfig, README (quickstart)
sdks/python/claimflow/    Python SDK
  models.py               (generated pydantic; do not edit)
  client.py               thin requests-based client
  __init__.py, pyproject.toml, README (quickstart)
docs/api/index.html       rendered Redoc docs (self-contained)
docs/api/redoc.standalone.js  vendored bundle
scripts/generate-sdks.sh  regenerates all of the above from docs/openapi.yaml
scripts/seed-sandbox.sh   sandbox: test tenant + test API key/OAuth client + synthetic claims
docs/sandbox-quickstart.md
```

## SDK client ergonomics (thin, stable wrappers — the only hand-written code)
Both SDKs expose:
- **Auth:** API key (`X-Api-Key: cf_…`) and OAuth2 client-credentials (exchange
  client_id/secret at `/v1/oauth/token`, cache the bearer until expiry).
- **Idempotency-Key** helper on the submission methods (`createClaim`, `scoreClaim`,
  `submitClaimBatch`).
- **problem+json parsing:** a typed `ClaimFlowError` with `status`, `code`, `title`,
  `detail`, `errors[]` — parses both problem+json (machine) and the envelope.
- A few typed convenience methods (score, submit batch, get batch status, list claims).
  Everything is typed off the **generated** types so adding a spec field flows through.

## No-internals verification (your hard rule, enforced in CI)
A test asserts the **generated** SDK artifacts:
- do NOT contain `deterministicScore`, `mlQualityScore`, `fixReportMd`;
- do NOT contain a `/internal` path or `*Internal` operation;
- DO contain the closed scoring/audit types (`ClaimScoreResult`, `AuditSummary`).
Runs against both `packages/sdk-node/src/generated/types.ts` and
`sdks/python/claimflow/models.py`. (This is downstream of the spec's own drift
no-leakage check, but proves the leak can't reappear via the SDK layer.)

## Sandbox (synthetic data ONLY)
`scripts/seed-sandbox.sh` (idempotent): creates a `sandbox` tenant + facility + a
human user, **one API key** (`claim:create, audit:trigger, …`) and **one OAuth
client**, and a handful of **synthetic** claims (no real PHI — clearly fake patient
ids/names). Prints the key + client secret once. `docs/sandbox-quickstart.md` walks
through: get a token / use the key → score a claim → submit a batch → poll status,
using each SDK. The existing no-PHI discipline (item 9 will add a CI guard) applies.

## CI
- New workspace member `@claimflow/sdk-node` builds under `pnpm build`/`typecheck`.
- `scripts/generate-sdks.sh --check` (regenerate + `git diff --exit-code`) wired into
  CI so SDK drift fails the build — the regenerable guarantee.
- The no-internals test runs in the workspace test job (no DB needed).

## Safety / merge classification
Additive: new packages, generated artifacts, docs, a seed script. **No** change to
auth, tenant isolation, rate-limiting, PHI handling, or migrations. Per policy this
is **auto-merge eligible once CI is green** — EXCEPT the publish step, which is a
STOP GATE (do not `npm publish` / `twine upload`; present for Jesse's go).
