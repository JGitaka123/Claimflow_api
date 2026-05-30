# ClaimFlow — SHA Claims Documentation Audit Platform

## Project Overview
ClaimFlow is a **deterministic** claims documentation audit platform deployed inside
Kenyan hospitals. It verifies SHA (Social Health Authority) claims documentation for
completeness, consistency, validity, and tariff correctness **before** submission to the
AfyaLink HIE. It ingests claim documents (PDFs, images, structured data), extracts and
validates them through a rule engine, and produces audit reports that flag documentation
gaps and compliance issues prior to national submission.

## Specification Documents
- `docs/ClaimFlow_Complete_Specification_Package.md` — Full specification (Sections 1-37). This is the source of truth for behavior; consult it before changing domain logic.
- `reference-data/` — Source SHA tariff PDFs, the SHA claim form, and a portal screenshot used to derive rules and reference data. Not loaded at runtime.

## Technology Stack
- **Backend API + Rule Engine:** TypeScript + Fastify 4 (Node.js 20 LTS)
- **Frontend:** Next.js 14 (App Router, TypeScript, React 18, TanStack Query)
- **ML Service:** Python 3.11 + FastAPI (Tesseract OCR, document classification, field extraction)
- **Database:** PostgreSQL 17
- **Job Queue:** pg-boss (Postgres-native)
- **Storage:** Local filesystem behind a `DocumentStore` interface
- **Auth:** In-app JWT RS256 + TOTP MFA (`speakeasy`)
- **Package Manager:** pnpm 10 workspaces (`packageManager: pnpm@10.30.3`)
- **Testing:** Vitest (TS), pytest (Python), Playwright (e2e, planned)
- **Validation:** Zod (shared between API request validation and rule/domain schemas)

## Architecture
Modular monolith deployed as Docker containers against a **single shared database**.
The **API ↔ ML service HTTP call is the only network boundary** in the system. Everything
else (rule engine, sync agent, workers) runs in-process or against Postgres directly.

```
┌─────────┐   HTTP    ┌──────────────┐   HTTP    ┌──────────────┐
│   web   │ ────────► │     api      │ ────────► │  ml-service  │
│ Next.js │           │   Fastify    │           │   FastAPI    │
└─────────┘           └──────┬───────┘           └──────────────┘
                             │  in-process: rule-engine, workers, sync-agent
                       ┌─────▼──────┐
                       │ PostgreSQL │  (+ pg-boss queue, outbox)
                       └────────────┘
```

## Repository Layout (pnpm workspace)
Workspace globs: `packages/*` (see `pnpm-workspace.yaml`). Shared TS config in `tsconfig.base.json`.

```
packages/
  api/          @claimflow/api — Fastify REST API, rule-engine orchestration, workers
  web/          @claimflow/web — Next.js 14 frontend (runs on port 3001)
  ml-service/   @claimflow/ml-service — Python FastAPI (OCR/classify/extract); managed via pip, not pnpm
  rule-engine/  @claimflow/rule-engine — deterministic validation engine + evaluators
  shared/       @claimflow/shared — shared Zod schemas, types, and utilities
  sync-agent/   @claimflow/sync-agent — AfyaLink HIE synchronization agent
migrations/     numbered SQL migrations (001…015), applied in lexical order
rulepacks/      versioned JSON rulepacks (e.g. v1.0.0/) loaded by the rule engine
reference-data/ source SHA tariff/claim PDFs (reference only)
scripts/        bash operational scripts (migrate, setup, seed, backup, restore, keys)
docker/         Dockerfiles + docker-compose.yml (postgres, api, ml-service, web)
docs/           full specification package
```

### `packages/api` internal structure
- `src/index.ts` — Fastify bootstrap; `src/config.ts` — Zod-validated env config (fails fast)
- `src/routes/` — route handlers: `auth`, `claims`, `documents`, `audits`, `rulepacks`, `tariffs`, `preauthorizations`, `health`
- `src/services/` — business logic: `claim-service`, `document-service`, `document-store`, `extraction-service`, `ml-client`, `audit-service`, `auth-service`, `rulepack-service`, `tariff-service`, `preauthorization-service`
- `src/middleware/` — `auth`, `tenant` (enforces tenant scoping), `error-handler`
- `src/lib/` — `jwt`, `totp`, `crypto`, `envelope`, `errors`, `logger`, `audit-log`
- `src/workers/` — pg-boss workers (e.g. `extraction-worker`)
- `src/db/` — pg client/pool; `src/schemas/` — request schemas; `src/plugins/` — Fastify plugins
- `test/` — `unit/`, `integration/`, `performance/`

### `packages/rule-engine` internal structure
- `src/engine.ts` — `RuleEngine` class; loads a rulepack version, runs all evaluators, aggregates an `AuditResult`
- `src/evaluators/` — `completeness`, `consistency`, `validity`, `tariff` (one per `RuleCategory`)
- `src/loader.ts` — loads/validates rulepack JSON from `RULEPACK_DIR`
- `src/types.ts` — `RuleSeverity` (ERROR/WARNING/INFO), `RuleCategory`, `RuleDefinition`, `RuleResult`, `AuditResult`
- `src/__tests__/` — engine and evaluator tests

**Determinism guarantees (do not break these):** no randomness, no wall-clock-dependent
logic except the `evaluatedAt` timestamp; rules evaluated in stable sorted order by `ruleId`;
the same claim + same rulepack version must always produce identical results.

### Rulepacks (`rulepacks/v1.0.0/`)
- `manifest.json` — version, effective date, category→file map, checksum
- `completeness.json`, `consistency.json`, `validity.json`, `tariff.json` — rule definitions
- Rules are **data, not code**. Prefer adding/editing rulepack JSON over hardcoding logic in
  evaluators. Bump the rulepack version directory for changes that alter audit outcomes.

### `packages/ml-service` (Python)
- `app/main.py` — FastAPI entry; `app/routes/` — `classify`, `extract`, `health`
- `app/ocr/` (Tesseract wrapper), `app/classifiers/`, `app/extractors/`
- `app/models.py` — Pydantic request/response models; `app/config.py` — config
- `tests/` — pytest. Managed via `pip`/`venv`, **not** pnpm (its package.json is a placeholder).

## Development Workflows

### First-time setup
```bash
pnpm install                                  # install workspace deps
pnpm exec bash scripts/generate-keys.sh       # generate RSA keypair for JWT RS256
docker compose -f docker/docker-compose.yml up -d   # start Postgres (+ services)
pnpm migrate                                   # apply SQL migrations
pnpm seed:test-data                            # optional seed data
pnpm dev                                        # start all dev servers in parallel
```
`pnpm setup:first-run` (or `:non-interactive`) wraps the bootstrap in `scripts/setup.sh`.

### Root scripts (run from repo root)
| Command | Action |
|---|---|
| `pnpm dev` | `pnpm -r --parallel dev` — all package dev servers |
| `pnpm build` | `pnpm -r build` — build every package |
| `pnpm test` | `pnpm -r test` — run all package tests |
| `pnpm test:coverage` | tests with coverage |
| `pnpm lint` | `pnpm -r lint` |
| `pnpm typecheck` | `pnpm -r typecheck` |
| `pnpm migrate` | `bash scripts/migrate.sh` |
| `pnpm seed:test-data` | seed test data |
| `pnpm backup` / `pnpm restore` | DB backup/restore via scripts |
| `pnpm verify:backup-restore` | backup/restore round-trip check |
| `pnpm perf:api` | API performance tests (`@claimflow/api test:performance`) |
| `pnpm clean` | remove `dist/` and `node_modules/` across packages |

### Per-package scripts
- **TS packages** (`api`, `rule-engine`, `shared`, `sync-agent`): `build` (`tsc`), `test`/`test:watch` (Vitest), `lint` (`eslint src --ext .ts`), `typecheck` (`tsc --noEmit`); services also have `dev` (`tsx watch src/index.ts`) and `start` (`node dist/index.js`).
- **web**: `dev`/`start` on port **3001** (`next dev/start -p 3001`), `build` (`next build`), `lint` (`next lint`), `test` (Vitest).
- **ml-service**: `cd packages/ml-service && python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000`; tests via `pytest`.

### Running a single package / test
```bash
pnpm --filter @claimflow/api test            # one package's tests
pnpm --filter @claimflow/rule-engine dev     # one package in watch mode
pnpm --filter @claimflow/api exec vitest run src/...  # a specific test file
```

### Database migrations
- Plain numbered `.sql` files in `migrations/`, applied in **lexical order** by `scripts/migrate.sh`.
- Applied versions are tracked in the `schema_migrations` table; re-running skips applied files.
- `DATABASE_URL` controls the target (defaults to local dev DB).
- To add a migration, create the next `NNN_description.sql`. ⚠️ Note there are currently **two**
  files prefixed `015` (`015_audit_user_actions.sql`, `015_preauthorizations.sql`) — pick a
  fresh, unambiguous prefix (e.g. `016_…`) for new migrations to avoid ordering collisions.
- In Docker, `migrations/` is also mounted into Postgres `docker-entrypoint-initdb.d`.

### Ports
- API: `3000` · ML service: `8000` · web: `3001` · Postgres: `5432`

## CI
`.github/workflows/ci.yml` runs on push/PR to `main` with a Postgres 17 service, then:
`pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm build` →
`pnpm test` → `pnpm migrate`. **Keep all of these green** before pushing; match CI locally
by running `pnpm lint && pnpm typecheck && pnpm build && pnpm test`.

## Configuration
Env is validated at startup by `packages/api/src/config.ts` (Zod) — missing/malformed config
fails fast. Copy `.env.example` → `.env`. Key vars: `DATABASE_URL`, `JWT_PRIVATE_KEY_PATH`/
`JWT_PUBLIC_KEY_PATH` (RS256, from `scripts/generate-keys.sh`), `JWT_ACCESS_TOKEN_TTL`
(15m) / `JWT_REFRESH_TOKEN_TTL` (7d), `ML_SERVICE_URL`, `RULEPACK_DIR`,
`DOCUMENT_STORE_PATH`, `MAX_UPLOAD_SIZE_BYTES` (20 MiB), `LOG_LEVEL`.

## Code Conventions
- **Strict TypeScript** — no `any`. `tsconfig.base.json` enables `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `isolatedModules`, `verbatimModuleSyntax`.
- **ESM everywhere** (`"type": "module"`); use explicit `.js` extensions in relative imports
  (e.g. `import { x } from './types.js'`) to satisfy `verbatimModuleSyntax`/bundler resolution.
- **Multi-tenancy:** every domain table has `tenant_id`; **every query must be tenant-scoped**.
  The `tenant` middleware enforces request scoping — never bypass it.
- **API responses use the envelope** `{ data, meta?, errors? }` (see `lib/envelope.ts` / `utils/envelope.ts`).
- **Validation:** Zod for all request validation and shared domain schemas (defined in `@claimflow/shared` and `rule-engine/types.ts`). Derive TS types from Zod via `z.infer`.
- **Dates:** ISO 8601 strings everywhere.
- **Money:** `NUMERIC(12,2)`, stored as KES; use `shared/utils/money.ts` helpers.
- **IDs:** UUIDs for all primary keys (`gen_random_uuid()`).
- **Logging:** structured JSON via `pino` (`lib/logger.ts`); **no `console.log` in production code.**
- **Errors:** use the typed errors in `lib/errors.ts` and the central `error-handler` middleware.
- **Shared code** belongs in `@claimflow/shared`; import it as `@claimflow/shared` rather than reaching across packages with relative paths.

## Pilot Hospital
Mary Help of the Sick Mission Hospital, Thika, Kiambu County
- SHA Facility Registry: FID-22-106718-4
- Registration Number: 000210
- Level: LEVEL_4

## Git / Contribution Notes
- Default branch: `main`. CI gates merges; do not push directly to `main` unless asked.
- Commit only when requested; keep commits focused and descriptive.
- Do **not** create pull requests unless explicitly asked.
