# ClaimFlow — SHA Claims Documentation Audit Platform

## Project Overview
ClaimFlow is an on-prem, **deterministic** claims documentation audit platform deployed
inside Kenyan hospitals. It verifies SHA (Social Health Authority) claims documentation for
completeness, consistency, validity, and tariff correctness **before** submission to the
AfyaLink HIE. It ingests claim documents (PDFs/images), runs OCR + field extraction, evaluates
them against a versioned rulepack, and produces an audit decision plus a human-readable
"fix report" so staff can correct issues before national submission.

## Specification Documents
- `docs/ClaimFlow_Complete_Specification_Package.md` — Full specification (Sections 1-37). Source of truth for domain behavior; consult before changing audit/business logic.
- `reference-data/` — Source SHA tariff PDFs, the SHA claim form, and a portal screenshot used to derive rules/reference data. Not loaded at runtime.

## Technology Stack
- **Backend API + Rule Engine:** TypeScript + Fastify 4 (Node.js 20 LTS, ESM)
- **Frontend:** Next.js 14 (App Router), React 18, TanStack Query, Tailwind, next-intl (en/sw), Radix UI, recharts
- **ML Service:** Python 3.11 + FastAPI (Tesseract + PaddleOCR, pypdfium2, OpenCV) — **not** a pnpm workspace member
- **Database:** PostgreSQL 17 (`pgcrypto`)
- **Job Queue:** pg-boss (Postgres-native)
- **Storage:** Local filesystem behind a `DocumentStore` interface
- **Auth:** In-app JWT RS256 (`jsonwebtoken`) + TOTP MFA (`otplib`); passwords via `bcryptjs`
- **Package Manager:** pnpm 10 workspaces (`packageManager: pnpm@10.30.3`, Node `>=20`)
- **Testing:** Vitest (TS unit + integration), pytest (Python), Playwright (web e2e)
- **Validation:** Zod (request validation + shared domain schemas)

## Architecture
Modular monolith deployed as Docker containers against a **single shared database**. The
**API ↔ ML-service HTTP call is the only network boundary** in the system. Everything else
(rule engine, pg-boss workers, sync agent) runs in-process or directly against Postgres.

```
┌─────────┐  HTTP  ┌──────────────┐  HTTP  ┌──────────────┐
│   web   │ ─────► │     api      │ ─────► │  ml-service  │
│ Next 14 │ :3000  │  Fastify     │ :8080  │  FastAPI :8000│
└─────────┘        └──────┬───────┘        └──────────────┘
                          │ in-process: rule-engine, pg-boss workers, sync-agent
                    ┌─────▼──────┐
                    │ PostgreSQL │ :5432  (+ pg-boss queue, outbox)
                    └────────────┘
```
**Ports:** API `8080` · ML `8000` · web `3000` · Postgres `5432`.

## Repository Layout
pnpm workspace members (`pnpm-workspace.yaml`): `shared`, `rule-engine`, `api`, `web`,
`sync-agent`. **`packages/ml-service` is Python and is *not* in the pnpm workspace.**

```
packages/
  shared/       @claimflow/shared — Zod schemas, shared types, constants, i18n (dependency of everything)
  rule-engine/  @claimflow/rule-engine — deterministic rule evaluation engine
  api/          @claimflow/api — Fastify REST API, workflows, pg-boss workers, ML client
  web/          @claimflow/web — Next.js 14 frontend
  sync-agent/   @claimflow/sync-agent — control-plane / rulepack sync + metrics uploader
  ml-service/   Python FastAPI OCR/classify/extract service (pip, not pnpm)
migrations/     numbered SQL migrations (001…015), applied in lexical order
rulepacks/      versioned YAML rulepacks (v1.0.0/) loaded by the rule engine
reference-data/ source SHA tariff/claim PDFs (reference only)
scripts/        bash ops scripts (setup, migrate, seed, backup, restore, generate-keys)
docker/         Dockerfiles + docker-compose.yml (postgres, api, web, ml)
docs/           full specification package
```

### `packages/shared` (build/import first — others depend on it)
- `src/index.ts` — barrel export. Import as `@claimflow/shared`, never via relative cross-package paths.
- `src/types/` — `api`, `auth`, `claim`, `document`, `fhir`, `preauthorization`, `rule`
- `src/constants/` — `claim-states`, `error-codes`, `icd11-codes` (ICD-11), `sha-tariffs`
- `src/validation/schemas.ts` — Zod schemas; derive TS types via `z.infer`
- `src/i18n/` — `en.json`, `sw.json` (English + Swahili)

### `packages/rule-engine` — the deterministic core
- `src/engine.ts` — `createRuleEngine(rulepackDir, version='1.0.0')` → `{ evaluate(input, locale?), reload(version?), activeVersion }`. Caches the loaded rulepack; `reload()` swaps versions.
- `src/loader.ts` — loads + validates rulepack YAML from `RULEPACK_DIR/<version>/`
- `src/evaluator.ts` — runs the rulepack over a `RuleEngineInput`, returns `RuleEngineOutput`
- `src/registry.ts` / `src/rules/catalog.ts` — wire rule IDs to their logic functions
- `src/rules/` — one module per category: `authorization`, `clinical`, `documentation`, `financial`, `identity`, `structural` (+ `utils.ts`)
- `src/fix-report.ts` — renders the human-readable Markdown fix report
- `src/types.ts` — `RuleEngineInput` (claim snapshot, extracted fields map, documents, facility context, tariff/ICD/registry lookups), `RuleEngineOutput` (`decision`, `results`, `fixReportMarkdown`, timings)

**Determinism guarantees (do not break):** no randomness; no wall-clock dependence beyond
recorded timestamps; stable evaluation order; the same claim + same rulepack version must
always yield identical results. Prefer changing **rulepack YAML** (data) over evaluator code.

### Rulepacks (`rulepacks/v1.0.0/`) — YAML, not JSON
- `manifest.yaml` + one file per category: `authorization.yaml`, `clinical.yaml`,
  `documentation.yaml`, `financial.yaml`, `identity.yaml`, `structural.yaml`
- Rules are **data**. For changes that alter audit outcomes, create a new version directory
  (e.g. `rulepacks/v1.1.0/`) rather than mutating `v1.0.0` in place.

### `packages/api`
- `src/server.ts` — Fastify bootstrap (**entry point**; dev = `tsx watch src/server.ts`)
- `src/config.ts` — Zod-validated env (`loadConfig`); fails fast. In production it **rejects** an `ML_SERVICE_URL` pointing at localhost/loopback.
- `src/routes/` — `auth`, `claims`, `documents`, `audit`, `extraction`, `preauthorizations`, `admin`, `dashboard`, `metrics`, `health` (registered via `routes/index.ts`)
- `src/services/` — `auth-service`, `claim-service`, `document-service`, `extraction-service`, `export-service`, `preauthorization-service`
- `src/plugins/` — `auth`, `tenant` (enforces tenant scoping), `error-handler`, `rate-limit`, `metrics`
- `src/integrations/` — `ml-client`, `ml-network` (host validation), `circuit-breaker`
- `src/jobs/` — pg-boss `setup.ts`, `types.ts`, and `handlers/`: `process-document`, `run-audit`, `batch-audit`, `generate-export`
- `src/workflows/` — `audit-pipeline.ts`, `state-machine.ts` (claim lifecycle)
- `src/storage/` — `document-store.ts` (interface) + `local-fs-store.ts`
- `src/db/client.ts` (pg pool) · `src/logging/sanitizer.ts` (PII-safe logs) · `src/types/`
- `src/__tests__/` — Vitest unit + `*.integration.test.ts` (Postgres-backed)

### `packages/ml-service` (Python / FastAPI)
- `app/main.py` — FastAPI app; `ProcessDocumentRequest` with `processing_route` ∈ `FULL_OCR_EXTRACT | EXISTENCE_QUALITY_ONLY | STRUCTURED_EXTRACT | SIGNATURE_DETECT_ONLY`
- `app/routers/` — `ocr`, `classify`, `quality`, `signature`
- `app/engines/` — `document_loader` (PDF/image → pages), `field_extractor` (SHA claim fields)
- `tests/` — pytest (`test_health`, `test_ocr`, `test_quality`); deps in `requirements.txt`

### `packages/web` (Next.js 14 App Router)
- `src/app/` — routes: `(auth)/login`, `dashboard`, `claims` (list / `new` / `[id]` / `[id]/audit`), `admin`
- `src/components/ui/` — `AppShell`, `DataTable`, `StatusBadge`, `PageHeader`, `LocaleSwitcher`, `LoadingSpinner`
- `src/contexts/auth-context.tsx`, `src/lib/api-client.ts`, `src/lib/i18n*.ts`, `src/middleware.ts`, `src/messages/{en,sw}.json`
- `tests/e2e/` — Playwright specs

### `packages/sync-agent`
- `agent.ts`, `rulepack-sync.ts`, `license-validator.ts`, `metrics-uploader.ts`, `config.ts`, `db.ts` — syncs rulepacks/license/metrics with an optional control plane (`CONTROL_PLANE_URL`, `SYNC_GOVERNANCE_MODE`).

## Development Workflows

### First-time setup
```bash
pnpm install
cp docker/.env.example docker/.env          # set DB_PASSWORD, etc.
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
pnpm migrate                                  # apply SQL migrations (needs DATABASE_URL)
pnpm seed:test-data                           # optional demo/training claims
pnpm dev                                       # all TS dev servers in parallel
```
Or use the bootstrap script (env prep, RSA keys, migrations, baseline tenant/facility/admin):
`pnpm setup:first-run` / `pnpm setup:first-run:non-interactive` (wraps `scripts/setup.sh`).

### Root scripts (run from repo root)
| Command | Action |
|---|---|
| `pnpm dev` | `pnpm -r --parallel dev` — all package dev servers |
| `pnpm build` | `pnpm -r build` — `tsc` build every TS package |
| `pnpm test` | `pnpm -r test` — Vitest across packages (web has no `test`; it uses e2e) |
| `pnpm typecheck` | `pnpm -r typecheck` |
| `pnpm migrate` | `bash scripts/migrate.sh` |
| `pnpm seed:test-data` | seed demo data |
| `pnpm backup` / `pnpm restore` | DB+data backup/restore |
| `pnpm verify:backup-restore` | destructive backup→restore round-trip check |
| `pnpm perf:api` | API SLO benchmark (`@claimflow/api test:performance`) |
| `pnpm clean` | remove `dist/` and `node_modules/` across packages |

> Note: a root `lint` script exists (`pnpm -r lint`) but **no package currently defines a
> `lint` script**, so it is effectively a no-op. The real quality gates are `pnpm typecheck`
> and `pnpm test` (what CI enforces). There is no ESLint/Prettier config in the repo today.

### Per-package conventions
- **TS packages** (`api`, `rule-engine`, `shared`, `sync-agent`): `build`=`tsc`, `test`/`test:watch`=Vitest. `api` & `rule-engine` typecheck with `tsc -p tsconfig.typecheck.json`; `shared` & `sync-agent` use `tsc --noEmit`. `api` also has `dev` (`tsx watch src/server.ts`) and `start` (`node dist/server.js`).
- **web**: `dev`/`build`/`start` (Next on port **3000**), `typecheck`, `test:e2e[:headed|:debug]` (Playwright).
- **ml-service**: `cd packages/ml-service && python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000`; tests via `pytest`.

### Running a single package / test
```bash
pnpm --filter @claimflow/api test                 # one package's Vitest suite
pnpm --filter @claimflow/api test:integration     # Postgres-backed integration tests
pnpm --filter @claimflow/rule-engine test:coverage
pnpm --filter @claimflow/web test:e2e             # Playwright
```
Integration tests need Postgres reachable via `CLAIMFLOW_TEST_DATABASE_URL`
(e.g. `postgres://claimflow:dev@127.0.0.1:5432/claimflow`).

### Database migrations
- Plain numbered `migrations/NNN_description.sql`, applied in **lexical order** by `scripts/migrate.sh`, tracked in the `schema_migrations` table (re-running skips applied files). Target via `DATABASE_URL`.
- Conventions visible in `001`: `pgcrypto` + `gen_random_uuid()` UUID PKs, `tenant_id` FK on every domain table, `created_at`/`updated_at TIMESTAMPTZ`.
- ⚠️ There are currently **two `015_` files** (`015_audit_user_actions.sql`, `015_preauthorizations.sql`). Use a fresh unambiguous prefix (e.g. `016_…`) for new migrations.

## CI (`.github/workflows/ci.yml`)
Runs on push to `main` and on all PRs (Node 20, pnpm 10.30.3, `--frozen-lockfile`). Three jobs:
1. **Typecheck + Workspace Tests** — `pnpm typecheck` then `pnpm test`
2. **API Integration (Postgres)** — Postgres 17 service, `pnpm --filter @claimflow/api test:integration`
3. **Web E2E (Playwright)** — installs Chromium, `pnpm --filter @claimflow/web test:e2e`

Match CI locally before pushing: `pnpm typecheck && pnpm test`, plus the integration/e2e
filters above when you touch the API or web. (CI does **not** run `pnpm build` or `pnpm migrate`.)

## Configuration
Env is Zod-validated at startup (`packages/api/src/config.ts`); missing/invalid config aborts
boot. Copy `.env.example` → `.env`. Notable vars (defaults in parens):
- **Core:** `NODE_ENV`, `PORT` (8080), `DATABASE_URL` (required), `DB_POOL_MIN/MAX`, `STORAGE_PATH` (/data)
- **ML:** `ML_SERVICE_URL` (http://ml:8000), `ML_TIMEOUT_MS` (60000) — must be an internal host in production
- **Rules:** `RULEPACK_DIR` (/data/rulepacks)
- **Auth:** `KEY_PATH` (RS256 keys dir, from `scripts/generate-keys.sh`), `JWT_ACCESS_EXPIRY` (15m), `JWT_REFRESH_EXPIRY` (7d), `REQUIRE_MFA` (true), `PASSWORD_MIN_LENGTH` (12), `MAX_LOGIN_ATTEMPTS`, `LOCKOUT_DURATION_MINUTES`, `SESSION_IDLE_TIMEOUT_MINUTES`
- **Limits:** `RATE_LIMIT_RPM` (100), `MAX_UPLOAD_SIZE_MB` (50), `MAX_PAGES_PER_DOCUMENT` (50), `MAX_CLAIMS_PER_BATCH` (200), `BATCH_CONCURRENCY` (4)
- **OCR thresholds:** `CONF_THRESHOLD_HIGH` (0.85), `CONF_THRESHOLD_LOW` (0.60), `MANUAL_ENTRY_THRESHOLD` (0.40)
- **Sync/licensing:** `LICENSE_TOKEN`, `CONTROL_PLANE_URL`, `SYNC_GOVERNANCE_MODE` (METRICS_ONLY|DEIDENTIFIED|FULL_ANALYTICS), `SYNC_INTERVAL_HOURS`
- **AfyaLink/registry:** `AFYALINK_ENV` (UAT|PRODUCTION), `AFYALINK_CLIENT_ID/SECRET`, `CIRCUIT_BREAKER_THRESHOLD/RESET_MS`, `REGISTRY_CACHE_TTL_HOURS`
- **Observability:** `LOG_LEVEL` (info)

## Code Conventions
- **Strict TypeScript — no `any`.** `tsconfig.base.json`: ES2022, `module`/`moduleResolution` = `Node16`, `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `composite`/`incremental` project refs. (`exactOptionalPropertyTypes` is currently `false`.)
- **ESM everywhere** (`"type": "module"`, Node16 resolution): relative imports must use explicit `.js` extensions (e.g. `import { loadRulepack } from './loader.js'`).
- **Multi-tenancy:** every domain table carries `tenant_id`; **every query must be tenant-scoped.** The `tenant` plugin enforces request scoping — never bypass it.
- **API envelope:** all responses use `{ data, meta?, errors? }`.
- **Validation:** Zod for request validation and shared domain schemas (`@claimflow/shared`, `rule-engine/types.ts`); derive types with `z.infer`.
- **Dates:** ISO 8601 strings everywhere.
- **Money:** `NUMERIC(12,2)`, stored as KES.
- **IDs:** UUID primary keys (`gen_random_uuid()`).
- **Logging:** structured JSON via `pino`; route anything user/PII-bearing through `logging/sanitizer.ts`. No `console.log` in production code.
- **Shared code** lives in `@claimflow/shared` and is imported by name, not via cross-package relative paths.

## Pilot Hospital
Mary Help of the Sick Mission Hospital, Thika, Kiambu County
- SHA Facility Registry: FID-22-106718-4
- Registration Number: 000210
- Level: LEVEL_4

## Git / Contribution Notes
- Default branch: `main`; CI gates merges. Don't push directly to `main` unless asked.
- Commit only when requested; keep commits focused and descriptive.
- Do **not** open pull requests unless explicitly asked.
