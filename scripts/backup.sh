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

VERIFY_BACKUP="false"
RETENTION_DAYS="30"

log() {
  printf "[backup] %s\n" "$*"
}

fail() {
  printf "[backup] ERROR: %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify)
      VERIFY_BACKUP="true"
      shift
      ;;
    --retention-days)
      shift
      [ "$#" -gt 0 ] || fail "--retention-days requires a value"
      RETENTION_DAYS="$1"
      shift
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

require_cmd docker
require_cmd date
require_cmd sha256sum
require_cmd tar

[ -f "${ENV_FILE}" ] || fail "Missing ${ENV_FILE}. Run scripts/setup.sh first."
docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DB_DIR="${BACKUP_ROOT}/db"
DOCS_DIR="${BACKUP_ROOT}/documents"
KEYS_DIR="${BACKUP_ROOT}/keys"
MANIFEST_DIR="${BACKUP_ROOT}/manifests"

mkdir -p "${DB_DIR}" "${DOCS_DIR}" "${KEYS_DIR}" "${MANIFEST_DIR}"

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres >/dev/null

DB_BACKUP_FILE="${DB_DIR}/claimflow-${TIMESTAMP}.dump"
DOCS_BACKUP_FILE="${DOCS_DIR}/app-data-${TIMESTAMP}.tar.gz"
KEYS_BACKUP_FILE="${KEYS_DIR}/keys-${TIMESTAMP}.tar.gz"
MANIFEST_FILE="${MANIFEST_DIR}/backup-${TIMESTAMP}.sha256"

log "Creating PostgreSQL backup ${DB_BACKUP_FILE}"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
  pg_dump -U claimflow -d claimflow -Fc > "${DB_BACKUP_FILE}"

log "Archiving app data volume ${APP_DATA_VOLUME}"
docker run --rm \
  -v "${APP_DATA_VOLUME}:/source:ro" \
  -v "${DOCS_DIR}:/backup" \
  alpine:3.20 sh -c "tar -czf /backup/$(basename "${DOCS_BACKUP_FILE}") -C /source ."

log "Archiving key material volume ${KEYS_VOLUME}"
docker run --rm \
  -v "${KEYS_VOLUME}:/source:ro" \
  -v "${KEYS_DIR}:/backup" \
  alpine:3.20 sh -c "tar -czf /backup/$(basename "${KEYS_BACKUP_FILE}") -C /source ."

log "Writing checksum manifest ${MANIFEST_FILE}"
{
  sha256sum "${DB_BACKUP_FILE}"
  sha256sum "${DOCS_BACKUP_FILE}"
  sha256sum "${KEYS_BACKUP_FILE}"
} > "${MANIFEST_FILE}"

log "Pruning backups older than ${RETENTION_DAYS} days"
find "${DB_DIR}" -type f -name '*.dump' -mtime "+${RETENTION_DAYS}" -delete
find "${DOCS_DIR}" -type f -name '*.tar.gz' -mtime "+${RETENTION_DAYS}" -delete
find "${KEYS_DIR}" -type f -name '*.tar.gz' -mtime "+${RETENTION_DAYS}" -delete
find "${MANIFEST_DIR}" -type f -name '*.sha256' -mtime "+${RETENTION_DAYS}" -delete

if [ "${VERIFY_BACKUP}" = "true" ]; then
  VERIFY_DB="claimflow_verify_${TIMESTAMP//-/}"
  log "Verifying backup by restoring into ${VERIFY_DB}"

  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d postgres -c "DROP DATABASE IF EXISTS ${VERIFY_DB};"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d postgres -c "CREATE DATABASE ${VERIFY_DB};"

  cat "${DB_BACKUP_FILE}" | docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    pg_restore -v -U claimflow -d "${VERIFY_DB}" --no-owner --no-privileges

  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d "${VERIFY_DB}" -c "
      SELECT
        (SELECT count(*) FROM claims) AS claims_count,
        (SELECT count(*) FROM documents) AS documents_count,
        (SELECT count(*) FROM audit_sessions) AS audits_count;
    "

  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d postgres -c "DROP DATABASE IF EXISTS ${VERIFY_DB};"

  log "Backup verification complete"
fi

cat <<EOF

Backup completed successfully.

Database:  ${DB_BACKUP_FILE}
App data:  ${DOCS_BACKUP_FILE}
Keys:      ${KEYS_BACKUP_FILE}
Manifest:  ${MANIFEST_FILE}

To restore:
  bash scripts/restore.sh ${TIMESTAMP}
EOF
