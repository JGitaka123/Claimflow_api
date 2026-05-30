#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/docker/.env"
BACKUP_ROOT="${REPO_ROOT}/docker/data/backups"

COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-claimflow}"
APP_DATA_VOLUME="${COMPOSE_PROJECT}_app_data"
KEYS_VOLUME="${COMPOSE_PROJECT}_keys"

log() {
  printf "[restore] %s\n" "$*"
}

fail() {
  printf "[restore] ERROR: %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

wait_for_http() {
  local url="$1"
  local attempts=1
  local max_attempts=40

  while [ "${attempts}" -le "${max_attempts}" ]; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi

    sleep 2
    attempts=$((attempts + 1))
  done

  return 1
}

run_migrations() {
  local migration_file
  for migration_file in "${REPO_ROOT}"/migrations/*.sql; do
    docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
      psql -v ON_ERROR_STOP=1 -U claimflow -d claimflow < "${migration_file}"
  done
}

[ "$#" -eq 1 ] || fail "Usage: bash scripts/restore.sh <timestamp: YYYYMMDD-HHMMSS>"

TIMESTAMP="$1"
DB_BACKUP_FILE="${BACKUP_ROOT}/db/claimflow-${TIMESTAMP}.dump"
DOCS_BACKUP_FILE="${BACKUP_ROOT}/documents/app-data-${TIMESTAMP}.tar.gz"
KEYS_BACKUP_FILE="${BACKUP_ROOT}/keys/keys-${TIMESTAMP}.tar.gz"
MANIFEST_FILE="${BACKUP_ROOT}/manifests/backup-${TIMESTAMP}.sha256"

require_cmd docker
require_cmd curl
require_cmd sha256sum

[ -f "${ENV_FILE}" ] || fail "Missing ${ENV_FILE}. Run scripts/setup.sh first."
[ -f "${DB_BACKUP_FILE}" ] || fail "Missing database backup file: ${DB_BACKUP_FILE}"
[ -f "${DOCS_BACKUP_FILE}" ] || fail "Missing app data backup file: ${DOCS_BACKUP_FILE}"
[ -f "${KEYS_BACKUP_FILE}" ] || fail "Missing keys backup file: ${KEYS_BACKUP_FILE}"
[ -f "${MANIFEST_FILE}" ] || fail "Missing manifest file: ${MANIFEST_FILE}"

docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

log "Validating backup checksums"
sha256sum -c "${MANIFEST_FILE}"

log "Stopping application services"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" stop api web ml >/dev/null 2>&1 || true

log "Ensuring postgres is running"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres >/dev/null

log "Resetting claimflow database"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U claimflow -d postgres -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = 'claimflow' AND pid <> pg_backend_pid();
  "
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U claimflow -d postgres -c "DROP DATABASE IF EXISTS claimflow;"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U claimflow -d postgres -c "CREATE DATABASE claimflow;"

log "Restoring PostgreSQL dump"
cat "${DB_BACKUP_FILE}" | docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  pg_restore -v -U claimflow -d claimflow --no-owner --no-privileges

log "Restoring app data volume ${APP_DATA_VOLUME}"
docker run --rm \
  -v "${APP_DATA_VOLUME}:/target" \
  -v "${BACKUP_ROOT}/documents:/backup:ro" \
  alpine:3.20 sh -c "rm -rf /target/* && tar -xzf /backup/$(basename "${DOCS_BACKUP_FILE}") -C /target"

log "Restoring key volume ${KEYS_VOLUME}"
docker run --rm \
  -v "${KEYS_VOLUME}:/target" \
  -v "${BACKUP_ROOT}/keys:/backup:ro" \
  alpine:3.20 sh -c "rm -rf /target/* && tar -xzf /backup/$(basename "${KEYS_BACKUP_FILE}") -C /target"

log "Applying forward migrations"
run_migrations

log "Restarting all services"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d

if ! wait_for_http "http://localhost:${API_PORT:-8080}/health"; then
  fail "API health check failed after restore"
fi

if ! wait_for_http "http://localhost:${ML_PORT:-8000}/health"; then
  fail "ML service health check failed after restore"
fi

if ! wait_for_http "http://localhost:${WEB_PORT:-3000}"; then
  fail "Web service health check failed after restore"
fi

cat <<EOF

Restore completed successfully for backup ${TIMESTAMP}.

Services are healthy:
  API: http://localhost:${API_PORT:-8080}/health
  ML:  http://localhost:${ML_PORT:-8000}/health
  Web: http://localhost:${WEB_PORT:-3000}
EOF
