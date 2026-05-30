#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/docker/.env"
BACKUP_ROOT="${REPO_ROOT}/docker/data/backups"

COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-claimflow}"
APP_DATA_VOLUME="${COMPOSE_PROJECT}_app_data"

RUN_BACKUP="true"
TIMESTAMP=""
RETENTION_DAYS="30"
ACK_DESTRUCTIVE="false"

log() {
  printf "[verify-backup-restore] %s\n" "$*"
}

fail() {
  printf "[verify-backup-restore] ERROR: %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

usage() {
  cat <<EOF
Usage: bash scripts/verify-backup-restore.sh [options]

Destructive full-cycle verification:
1) Creates (or reuses) a backup timestamp
2) Intentionally tampers DB and app-data volume
3) Runs scripts/restore.sh <timestamp>
4) Verifies tamper artifacts are removed after restore

Options:
  --timestamp <YYYYMMDD-HHMMSS>  Use an existing backup timestamp (skips backup unless --run-backup)
  --skip-backup                  Do not create a new backup; require --timestamp
  --run-backup                   Force creating a fresh backup before verification (default)
  --retention-days <N>           Passed to backup.sh when creating fresh backup (default: 30)
  --yes                          Required acknowledgement for destructive restore operation
  -h, --help                     Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --timestamp)
      shift
      [ "$#" -gt 0 ] || fail "--timestamp requires a value"
      TIMESTAMP="$1"
      shift
      ;;
    --skip-backup)
      RUN_BACKUP="false"
      shift
      ;;
    --run-backup)
      RUN_BACKUP="true"
      shift
      ;;
    --retention-days)
      shift
      [ "$#" -gt 0 ] || fail "--retention-days requires a value"
      RETENTION_DAYS="$1"
      shift
      ;;
    --yes)
      ACK_DESTRUCTIVE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[ "${ACK_DESTRUCTIVE}" = "true" ] || fail "Refusing destructive restore without --yes"

require_cmd docker
require_cmd bash
require_cmd grep
require_cmd sed
require_cmd date

[ -f "${ENV_FILE}" ] || fail "Missing ${ENV_FILE}. Run scripts/setup.sh first."
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"

resolve_latest_timestamp() {
  local latest_manifest

  latest_manifest="$(ls -1t "${BACKUP_ROOT}/manifests"/backup-*.sha256 2>/dev/null | head -n1 || true)"
  [ -n "${latest_manifest}" ] || fail "No backup manifests found in ${BACKUP_ROOT}/manifests"

  basename "${latest_manifest}" | sed -E 's/^backup-([0-9]{8}-[0-9]{6})\.sha256$/\1/'
}

if [ "${RUN_BACKUP}" = "true" ]; then
  log "Creating fresh backup with verification"
  bash "${REPO_ROOT}/scripts/backup.sh" --verify --retention-days "${RETENTION_DAYS}"
  TIMESTAMP="$(resolve_latest_timestamp)"
elif [ -z "${TIMESTAMP}" ]; then
  fail "--skip-backup requires --timestamp"
fi

[ -n "${TIMESTAMP}" ] || fail "Unable to resolve backup timestamp"

DB_BACKUP_FILE="${BACKUP_ROOT}/db/claimflow-${TIMESTAMP}.dump"
DOCS_BACKUP_FILE="${BACKUP_ROOT}/documents/app-data-${TIMESTAMP}.tar.gz"
KEYS_BACKUP_FILE="${BACKUP_ROOT}/keys/keys-${TIMESTAMP}.tar.gz"
MANIFEST_FILE="${BACKUP_ROOT}/manifests/backup-${TIMESTAMP}.sha256"

[ -f "${DB_BACKUP_FILE}" ] || fail "Missing database backup file: ${DB_BACKUP_FILE}"
[ -f "${DOCS_BACKUP_FILE}" ] || fail "Missing app data backup file: ${DOCS_BACKUP_FILE}"
[ -f "${KEYS_BACKUP_FILE}" ] || fail "Missing keys backup file: ${KEYS_BACKUP_FILE}"
[ -f "${MANIFEST_FILE}" ] || fail "Missing manifest file: ${MANIFEST_FILE}"

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

API_PORT="${API_PORT:-8080}"

TAMPER_SLUG="restore-probe-${TIMESTAMP}-$RANDOM"
TAMPER_FILE="/data/restore-probe/${TAMPER_SLUG}.txt"

log "Ensuring postgres is up"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres >/dev/null

log "Injecting DB tamper row (${TAMPER_SLUG})"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U claimflow -d claimflow -c "
    INSERT INTO tenants (name, slug)
    VALUES ('Restore Probe', '${TAMPER_SLUG}');
  "

TAMPER_DB_COUNT="$(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -U claimflow -d claimflow -tAc "SELECT COUNT(*) FROM tenants WHERE slug = '${TAMPER_SLUG}';" | tr -d '[:space:]')"

[ "${TAMPER_DB_COUNT}" = "1" ] || fail "Failed to create DB tamper marker"

log "Injecting app-data tamper file (${TAMPER_FILE})"
docker run --rm \
  -v "${APP_DATA_VOLUME}:/data" \
  alpine:3.20 sh -c "mkdir -p /data/restore-probe && echo '${TAMPER_SLUG}' > ${TAMPER_FILE}"

if ! docker run --rm -v "${APP_DATA_VOLUME}:/data" alpine:3.20 sh -c "test -f ${TAMPER_FILE}"; then
  fail "Failed to create app-data tamper marker"
fi

log "Running restore from backup timestamp ${TIMESTAMP}"
bash "${REPO_ROOT}/scripts/restore.sh" "${TIMESTAMP}"

log "Validating DB tamper row was removed by restore"
POST_DB_COUNT="$(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  psql -U claimflow -d claimflow -tAc "SELECT COUNT(*) FROM tenants WHERE slug = '${TAMPER_SLUG}';" | tr -d '[:space:]')"

[ "${POST_DB_COUNT}" = "0" ] || fail "DB tamper marker still present after restore"

log "Validating app-data tamper file was removed by restore"
if docker run --rm -v "${APP_DATA_VOLUME}:/data" alpine:3.20 sh -c "test -f ${TAMPER_FILE}"; then
  fail "App-data tamper file still present after restore"
fi

log "Checking API health"
curl -fsS "http://localhost:${API_PORT}/health" >/dev/null

cat <<EOF

Backup/restore full-cycle verification passed.

Timestamp verified: ${TIMESTAMP}
DB backup file:      ${DB_BACKUP_FILE}
App data backup file:${DOCS_BACKUP_FILE}
Keys backup file:    ${KEYS_BACKUP_FILE}

EOF
