# ClaimFlow

ClaimFlow is an on-prem SHA claims documentation audit platform.

## Operations Scripts

Run from the repository root on Linux/macOS (or WSL):

```bash
# First-run bootstrap (env prep, keys, migrations, baseline tenant/facility/admin)
bash scripts/setup.sh

# Non-interactive setup (Ubuntu/CI automation)
ADMIN_PASSWORD="ChangeMe123!" bash scripts/setup.sh --non-interactive

# PowerShell (Windows) non-interactive
$env:ADMIN_PASSWORD="ChangeMe123!"; bash scripts/setup.sh --non-interactive

# Seed training claims for demo/testing
bash scripts/seed-test-data.sh

# Create backup (database + app data + keys)
bash scripts/backup.sh --verify

# Restore from a backup timestamp
bash scripts/restore.sh YYYYMMDD-HHMMSS

# Destructive full-cycle verification (backup -> tamper -> restore -> verify)
bash scripts/verify-backup-restore.sh --yes
```

## Docker Compose

```bash
cp docker/.env.example docker/.env
docker compose -f docker/docker-compose.yml --env-file docker/.env up -d --build
```

If port `3000` is already in use (common when `pnpm --filter @claimflow/web dev` is running), start web on another host port:

```bash
WEB_PORT=3002 docker compose -f docker/docker-compose.yml --env-file docker/.env up -d web
```

Health checks:

- API: `http://localhost:8080/health`
- ML: `http://localhost:8000/health`
- Web: `http://localhost:3000`

Smoke validation:

```bash
docker compose -f docker/docker-compose.yml --env-file docker/.env ps
curl -f http://localhost:8080/health
curl -f http://localhost:8000/health
curl -f http://localhost:${WEB_PORT:-3000}/login
```

## Performance Testing (Step 33)

API SLO benchmark (uses integration Postgres + in-process ML stub):

```bash
# Start Postgres and set integration DB
export CLAIMFLOW_TEST_DATABASE_URL="postgres://claimflow:dev@127.0.0.1:5432/claimflow"

# Optional: enforce SLO thresholds and write JSON summary
export CLAIMFLOW_PERF_ENFORCE_SLO=true
export CLAIMFLOW_PERF_REPORT_PATH="tests/performance/latest-api-slo.json"

pnpm perf:api
```

PowerShell (Windows):

```powershell
$env:CLAIMFLOW_TEST_DATABASE_URL='postgres://claimflow:dev@127.0.0.1:5432/claimflow'
$env:CLAIMFLOW_PERF_ENFORCE_SLO='true'
$env:CLAIMFLOW_PERF_REPORT_PATH='tests/performance/latest-api-slo.json'
pnpm.cmd perf:api
```

Tunable env vars:

- `CLAIMFLOW_PERF_RUNS` (default `8`)
- `CLAIMFLOW_PERF_PAGE_COUNT` (default `20`)
- `CLAIMFLOW_PERF_ML_PAGE_DELAY_MS` (default `10`)
- `CLAIMFLOW_PERF_SLO_DETERMINISTIC_MS` (default `2000`)
- `CLAIMFLOW_PERF_SLO_FULL_PIPELINE_MS` (default `20000`)
- `CLAIMFLOW_PERF_TIMEOUT_MS` (default `300000`)
