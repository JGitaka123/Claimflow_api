#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/docker/.env"
ENV_EXAMPLE_FILE="${REPO_ROOT}/docker/.env.example"
RULEPACK_DIR="${REPO_ROOT}/rulepacks/v1.0.0"

COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-claimflow}"
KEYS_VOLUME="${COMPOSE_PROJECT}_keys"
RULEPACKS_VOLUME="${COMPOSE_PROJECT}_rulepacks"

NON_INTERACTIVE="false"
ADMIN_EMAIL_ARG=""
ADMIN_PASSWORD_ARG=""

log() {
  printf "[setup] %s\n" "$*"
}

fail() {
  printf "[setup] ERROR: %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

usage() {
  cat <<EOF
Usage: bash scripts/setup.sh [options]

Options:
  --non-interactive            Do not prompt for input (requires admin password via env or flag)
  --admin-email <email>        Override ADMIN_EMAIL
  --admin-password <password>  Provide admin password directly
  -h, --help                   Show this help
EOF
}

upsert_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
    rm -f "${ENV_FILE}.bak"
  else
    printf "%s=%s\n" "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

escape_sql_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

compose_exec_psql() {
  local sql="$1"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d claimflow -c "${sql}"
}

compose_apply_sql_file() {
  local file_path="$1"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d claimflow < "${file_path}"
}

wait_for_postgres() {
  local max_attempts=60
  local attempt=1

  while [ "${attempt}" -le "${max_attempts}" ]; do
    if docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
      pg_isready -U claimflow -d claimflow >/dev/null 2>&1; then
      return 0
    fi

    sleep 2
    attempt=$((attempt + 1))
  done

  fail "PostgreSQL did not become ready in time"
}

run_migrations() {
  log "Applying database migrations"

  compose_exec_psql "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"

  local migration_file
  for migration_file in "${REPO_ROOT}"/migrations/*.sql; do
    local filename
    filename="$(basename "${migration_file}")"

    local applied
    applied="$(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
      psql -U claimflow -d claimflow -tAc "SELECT COUNT(*) FROM schema_migrations WHERE filename = '${filename}';" | tr -d '[:space:]')"

    if [ "${applied}" = "0" ]; then
      log "Applying ${filename}"
      compose_apply_sql_file "${migration_file}"
      compose_exec_psql "INSERT INTO schema_migrations (filename) VALUES ('${filename}') ON CONFLICT (filename) DO NOTHING;"
    else
      log "Skipping ${filename} (already applied)"
    fi
  done
}

seed_reference_data() {
  log "Seeding baseline ICD-11 and SHA service reference data"

  compose_exec_psql "
    INSERT INTO icd_codes (code, version, title_en, title_sw, chapter, block, is_leaf) VALUES
      ('GB61', '11', 'Chronic kidney disease, stage 5', 'Ugonjwa sugu wa figo, hatua ya 5', '14', 'GB6', true),
      ('1A00', '11', 'Cholera due to Vibrio cholerae 01, biovar cholerae', 'Kipindupindu cha Vibrio cholerae 01', '01', '1A0', true),
      ('BA00', '11', 'Type 1 diabetes mellitus', 'Kisukari aina ya 1', '05', 'BA0', true),
      ('BA01', '11', 'Type 2 diabetes mellitus', 'Kisukari aina ya 2', '05', 'BA0', true),
      ('CA40', '11', 'Essential hypertension', 'Shinikizo la damu la msingi', '05', 'CA4', true),
      ('DA62', '11', 'Acute appendicitis', 'Appendicitis ya ghafla', '11', 'DA6', true),
      ('JA63', '11', 'Asthma', 'Pumu', '12', 'JA6', true),
      ('KA63', '11', 'Single spontaneous delivery', 'Kujifungua kwa kawaida mtoto mmoja', '16', 'KA6', true)
    ON CONFLICT (code) DO NOTHING;
  "

  compose_exec_psql "
    INSERT INTO sha_service_codes (code, description, category, benefit_packages, requires_preauth) VALUES
      ('SVC-OP-001', 'Outpatient consultation', 'OUTPATIENT', '[\"SHIF\"]'::jsonb, false),
      ('SVC-LAB-001', 'Laboratory panel', 'LAB', '[\"SHIF\"]'::jsonb, false),
      ('SVC-IP-001', 'Inpatient daily bed charge', 'INPATIENT', '[\"SHIF\"]'::jsonb, false),
      ('SVC-MAT-001', 'Normal delivery package', 'MATERNITY', '[\"SHIF\"]'::jsonb, false),
      ('SVC-SURG-001', 'Minor surgery package', 'SURGICAL', '[\"SHIF\"]'::jsonb, true)
    ON CONFLICT (code) DO NOTHING;
  "
}

seed_facility_and_admin() {
  local tenant_name="$1"
  local tenant_slug="$2"
  local facility_name="$3"
  local facility_code="$4"
  local facility_tier="$5"
  local county="$6"
  local sub_county="$7"
  local provider_id="$8"
  local admin_email="$9"
  local admin_password="${10}"

  local tenant_name_sql tenant_slug_sql facility_name_sql facility_code_sql facility_tier_sql county_sql sub_county_sql provider_id_sql admin_email_sql admin_password_sql
  tenant_name_sql="$(escape_sql_literal "${tenant_name}")"
  tenant_slug_sql="$(escape_sql_literal "${tenant_slug}")"
  facility_name_sql="$(escape_sql_literal "${facility_name}")"
  facility_code_sql="$(escape_sql_literal "${facility_code}")"
  facility_tier_sql="$(escape_sql_literal "${facility_tier}")"
  county_sql="$(escape_sql_literal "${county}")"
  sub_county_sql="$(escape_sql_literal "${sub_county}")"
  provider_id_sql="$(escape_sql_literal "${provider_id}")"
  admin_email_sql="$(escape_sql_literal "${admin_email}")"
  admin_password_sql="$(escape_sql_literal "${admin_password}")"

  log "Creating or updating tenant, facility, and super_admin user"

  compose_exec_psql "
    WITH upsert_tenant AS (
      INSERT INTO tenants (name, slug)
      VALUES ('${tenant_name_sql}', '${tenant_slug_sql}')
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        updated_at = now()
      RETURNING id
    ), selected_tenant AS (
      SELECT id FROM upsert_tenant
      UNION ALL
      SELECT id FROM tenants WHERE slug = '${tenant_slug_sql}'
      LIMIT 1
    ), upsert_facility AS (
      INSERT INTO facilities (
        tenant_id, name, sha_facility_code, sha_provider_id, tier_level,
        license_status, county, sub_county, facility_type
      )
      SELECT
        selected_tenant.id,
        '${facility_name_sql}',
        '${facility_code_sql}',
        NULLIF('${provider_id_sql}', ''),
        '${facility_tier_sql}',
        'ACTIVE',
        '${county_sql}',
        NULLIF('${sub_county_sql}', ''),
        'HOSPITAL'
      FROM selected_tenant
      ON CONFLICT (tenant_id, sha_facility_code) DO UPDATE SET
        name = EXCLUDED.name,
        sha_provider_id = EXCLUDED.sha_provider_id,
        tier_level = EXCLUDED.tier_level,
        county = EXCLUDED.county,
        sub_county = EXCLUDED.sub_county,
        updated_at = now()
      RETURNING id, tenant_id
    ), selected_facility AS (
      SELECT id, tenant_id FROM upsert_facility
      UNION ALL
      SELECT id, tenant_id
      FROM facilities
      WHERE sha_facility_code = '${facility_code_sql}'
      ORDER BY created_at ASC
      LIMIT 1
    )
    INSERT INTO users (
      tenant_id, facility_id, email, display_name, password_hash, role, must_change_password
    )
    SELECT
      selected_facility.tenant_id,
      selected_facility.id,
      lower('${admin_email_sql}'),
      'System Administrator',
      crypt('${admin_password_sql}', gen_salt('bf', 12)),
      'super_admin',
      true
    FROM selected_facility
    ON CONFLICT (tenant_id, email) DO UPDATE SET
      facility_id = EXCLUDED.facility_id,
      display_name = EXCLUDED.display_name,
      password_hash = EXCLUDED.password_hash,
      role = EXCLUDED.role,
      is_active = true,
      updated_at = now();
  "

  local license_token_sql
  license_token_sql="$(escape_sql_literal "${LICENSE_TOKEN}")"

  compose_exec_psql "
    WITH selected_facility AS (
      SELECT f.id
      FROM facilities f
      JOIN tenants t ON t.id = f.tenant_id
      WHERE t.slug = '${tenant_slug_sql}'
        AND f.sha_facility_code = '${facility_code_sql}'
      LIMIT 1
    )
    INSERT INTO license_state (
      facility_id,
      tier,
      license_token,
      feature_flags,
      expires_at,
      offline_grace_until
    )
    SELECT
      selected_facility.id,
      'FREE',
      '${license_token_sql}',
      '{\"batchAudit\": false, \"advancedExports\": false}'::jsonb,
      now() + INTERVAL '365 days',
      now() + INTERVAL '14 days'
    FROM selected_facility
    ON CONFLICT (facility_id) DO UPDATE SET
      license_token = EXCLUDED.license_token,
      last_validated_at = now(),
      expires_at = GREATEST(license_state.expires_at, now() + INTERVAL '365 days');
  "
}

activate_bundled_rulepack() {
  [ -f "${RULEPACK_DIR}/manifest.yaml" ] || fail "Missing rulepack manifest at ${RULEPACK_DIR}/manifest.yaml"

  local version
  version="$(grep -E '^version:' "${RULEPACK_DIR}/manifest.yaml" | head -n1 | sed -E 's/version:[[:space:]]*"?([^"]+)"?/\1/')"
  local rule_count
  rule_count="$(grep -E '^rule_count:' "${RULEPACK_DIR}/manifest.yaml" | head -n1 | awk '{print $2}')"
  local description
  description="$(grep -E '^description:' "${RULEPACK_DIR}/manifest.yaml" | head -n1 | sed -E 's/description:[[:space:]]*"?([^"]+)"?/\1/')"
  local checksum
  checksum="$(
    cat \
      "${RULEPACK_DIR}/manifest.yaml" \
      "${RULEPACK_DIR}/identity.yaml" \
      "${RULEPACK_DIR}/documentation.yaml" \
      "${RULEPACK_DIR}/clinical.yaml" \
      "${RULEPACK_DIR}/authorization.yaml" \
      "${RULEPACK_DIR}/financial.yaml" \
      "${RULEPACK_DIR}/structural.yaml" \
      | sha256sum | awk '{print $1}'
  )"

  local major minor patch
  major="$(printf "%s" "${version}" | cut -d'.' -f1)"
  minor="$(printf "%s" "${version}" | cut -d'.' -f2)"
  patch="$(printf "%s" "${version}" | cut -d'.' -f3)"

  local version_sql description_sql checksum_sql
  version_sql="$(escape_sql_literal "${version}")"
  description_sql="$(escape_sql_literal "${description}")"
  checksum_sql="$(escape_sql_literal "${checksum}")"

  local admin_id
  admin_id="$(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -U claimflow -d claimflow -tAc "
      SELECT u.id
      FROM users u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.slug = '${TENANT_SLUG_SQL}'
        AND lower(u.email) = lower('${ADMIN_EMAIL_SQL}')
      ORDER BY u.created_at ASC
      LIMIT 1;
    " | tr -d '[:space:]')"

  if [ -z "${admin_id}" ]; then
    fail "Unable to resolve admin user id for rulepack activation"
  fi

  local admin_id_sql
  admin_id_sql="$(escape_sql_literal "${admin_id}")"

  compose_exec_psql "
    UPDATE rulepacks SET is_activated = false WHERE is_activated = true;

    INSERT INTO rulepacks (
      version_semver,
      version_major,
      version_minor,
      version_patch,
      sha_policy_version,
      description,
      rule_count,
      checksum,
      is_activated,
      activated_at,
      activated_by
    )
    VALUES (
      '${version_sql}',
      ${major},
      ${minor},
      ${patch},
      'LN-56-2025',
      '${description_sql}',
      ${rule_count},
      '${checksum_sql}',
      true,
      now(),
      '${admin_id_sql}'::uuid
    )
    ON CONFLICT (version_semver) DO UPDATE SET
      version_major = EXCLUDED.version_major,
      version_minor = EXCLUDED.version_minor,
      version_patch = EXCLUDED.version_patch,
      sha_policy_version = EXCLUDED.sha_policy_version,
      description = EXCLUDED.description,
      rule_count = EXCLUDED.rule_count,
      checksum = EXCLUDED.checksum,
      is_activated = true,
      activated_at = now(),
      activated_by = EXCLUDED.activated_by;
  "

  log "Activated bundled rulepack v${version}"
}

run_service_health_checks() {
  log "Starting all services"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d

  local endpoints=(
    "http://localhost:${API_PORT}/health"
    "http://localhost:${ML_PORT}/health"
    "http://localhost:${WEB_PORT}"
  )

  local endpoint
  for endpoint in "${endpoints[@]}"; do
    local attempts=1
    local max_attempts=30
    while [ "${attempts}" -le "${max_attempts}" ]; do
      if curl -fsS "${endpoint}" >/dev/null 2>&1; then
        log "Healthy: ${endpoint}"
        break
      fi

      if [ "${attempts}" -eq "${max_attempts}" ]; then
        fail "Health check failed for ${endpoint}"
      fi

      sleep 2
      attempts=$((attempts + 1))
    done
  done
}

print_registration_payload() {
  local tenant_id
  tenant_id="$(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -U claimflow -d claimflow -tAc "SELECT id FROM tenants WHERE slug = '${TENANT_SLUG_SQL}' LIMIT 1;" | tr -d '[:space:]')"

  local facility_id
  facility_id="$(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -U claimflow -d claimflow -tAc "SELECT f.id FROM facilities f JOIN tenants t ON t.id = f.tenant_id WHERE t.slug = '${TENANT_SLUG_SQL}' AND f.sha_facility_code = '${FACILITY_CODE_SQL}' LIMIT 1;" | tr -d '[:space:]')"

  local registration_token
  registration_token="$(printf "%s" "${tenant_id}:${facility_id}:${FACILITY_CODE}" | openssl dgst -sha256 -hmac "${LICENSE_TOKEN}" | awk '{print $2}')"

  cat <<EOF

ClaimFlow setup complete.

Registration payload (for control plane):
  tenant_slug: ${TENANT_SLUG}
  tenant_id: ${tenant_id}
  facility_id: ${facility_id}
  sha_facility_code: ${FACILITY_CODE}
  registration_token: ${registration_token}

Admin login bootstrap:
  email: ${ADMIN_EMAIL}
  password: [the password you entered]
  must_change_password: true

Services:
  API: http://localhost:${API_PORT}/health
  Web: http://localhost:${WEB_PORT}
  ML: http://localhost:${ML_PORT}/health
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --non-interactive)
      NON_INTERACTIVE="true"
      shift
      ;;
    --admin-email)
      shift
      [ "$#" -gt 0 ] || fail "--admin-email requires a value"
      ADMIN_EMAIL_ARG="$1"
      shift
      ;;
    --admin-password)
      shift
      [ "$#" -gt 0 ] || fail "--admin-password requires a value"
      ADMIN_PASSWORD_ARG="$1"
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
require_cmd docker
require_cmd openssl
require_cmd curl
require_cmd awk
require_cmd sed
require_cmd grep
require_cmd sha256sum

docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"

if [ ! -f "${ENV_FILE}" ]; then
  [ -f "${ENV_EXAMPLE_FILE}" ] || fail "Missing ${ENV_EXAMPLE_FILE}"
  cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
  log "Created ${ENV_FILE} from template"
fi

if ! grep -q '^DB_PASSWORD=' "${ENV_FILE}"; then
  upsert_env "DB_PASSWORD" "$(openssl rand -hex 18)"
fi

if grep -q '^DB_PASSWORD=dev$' "${ENV_FILE}"; then
  upsert_env "DB_PASSWORD" "$(openssl rand -hex 18)"
fi

if ! grep -q '^LICENSE_TOKEN=' "${ENV_FILE}" || grep -q '^LICENSE_TOKEN=$' "${ENV_FILE}"; then
  upsert_env "LICENSE_TOKEN" "trial-$(openssl rand -hex 20)"
fi

set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

API_PORT="${API_PORT:-8080}"
WEB_PORT="${WEB_PORT:-3000}"
ML_PORT="${ML_PORT:-8000}"

TENANT_NAME="${TENANT_NAME:-Mary Help Hospital}"
TENANT_SLUG="${TENANT_SLUG:-mary-help}"
FACILITY_NAME="${FACILITY_NAME:-Mary Help of the Sick Mission Hospital}"
FACILITY_CODE="${FACILITY_CODE:-FID-22-106718-4}"
FACILITY_TIER="${FACILITY_TIER:-LEVEL_4}"
FACILITY_COUNTY="${FACILITY_COUNTY:-KIAMBU}"
FACILITY_SUB_COUNTY="${FACILITY_SUB_COUNTY:-JUJA}"
FACILITY_PROVIDER_ID="${FACILITY_PROVIDER_ID:-000210}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@claimflow.local}"

printf "Default tenant: %s (%s)\n" "${TENANT_NAME}" "${TENANT_SLUG}"
printf "Default facility: %s [%s]\n" "${FACILITY_NAME}" "${FACILITY_CODE}"
printf "Default admin email: %s\n" "${ADMIN_EMAIL}"

if [ -n "${ADMIN_EMAIL_ARG}" ]; then
  ADMIN_EMAIL="${ADMIN_EMAIL_ARG}"
fi

if [ -n "${ADMIN_PASSWORD_ARG}" ]; then
  ADMIN_PASSWORD="${ADMIN_PASSWORD_ARG}"
fi

if [ "${NON_INTERACTIVE}" = "true" ]; then
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    fail "--non-interactive requires ADMIN_PASSWORD env var or --admin-password"
  fi

  ADMIN_PASSWORD_INPUT="${ADMIN_PASSWORD}"
  log "Running in non-interactive mode"
else
  read -r -p "Admin email [${ADMIN_EMAIL}]: " ADMIN_EMAIL_INPUT
  if [ -n "${ADMIN_EMAIL_INPUT}" ]; then
    ADMIN_EMAIL="${ADMIN_EMAIL_INPUT}"
  fi

  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD_INPUT="${ADMIN_PASSWORD}"
  else
    read -r -s -p "Admin password: " ADMIN_PASSWORD_INPUT
    printf "\n"
    read -r -s -p "Confirm admin password: " ADMIN_PASSWORD_CONFIRM
    printf "\n"
    [ "${ADMIN_PASSWORD_INPUT}" = "${ADMIN_PASSWORD_CONFIRM}" ] || fail "Passwords do not match"
  fi
fi

[ "${#ADMIN_PASSWORD_INPUT}" -ge 12 ] || fail "Admin password must be at least 12 characters"

TENANT_SLUG_SQL="$(escape_sql_literal "${TENANT_SLUG}")"
ADMIN_EMAIL_SQL="$(escape_sql_literal "${ADMIN_EMAIL}")"
FACILITY_CODE_SQL="$(escape_sql_literal "${FACILITY_CODE}")"

log "Preparing docker data directories"
mkdir -p "${REPO_ROOT}/docker/data/backups/wal" "${REPO_ROOT}/docker/data/backups/db" "${REPO_ROOT}/docker/data/backups/documents"

log "Generating key material in docker volume ${KEYS_VOLUME}"
docker volume create "${KEYS_VOLUME}" >/dev/null
docker run --rm -v "${KEYS_VOLUME}:/keys" alpine:3.20 sh -c "
  set -euo pipefail
  apk add --no-cache openssl >/dev/null
  if [ ! -f /keys/jwt_private.pem ] || [ ! -f /keys/jwt_public.pem ] || [ ! -f /keys/master.key ]; then
    openssl genrsa -out /keys/jwt_private.pem 2048
    openssl rsa -in /keys/jwt_private.pem -pubout -out /keys/jwt_public.pem
    openssl rand -hex 32 > /keys/master.key
    chmod 600 /keys/jwt_private.pem /keys/jwt_public.pem /keys/master.key
  fi
"

log "Seeding bundled rulepacks into docker volume ${RULEPACKS_VOLUME}"
docker volume create "${RULEPACKS_VOLUME}" >/dev/null
docker run --rm \
  -v "${RULEPACKS_VOLUME}:/dest" \
  -v "${REPO_ROOT}/rulepacks:/src:ro" \
  alpine:3.20 sh -c "cp -R /src/. /dest/"

log "Starting postgres service"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres
wait_for_postgres

run_migrations
seed_reference_data
seed_facility_and_admin \
  "${TENANT_NAME}" \
  "${TENANT_SLUG}" \
  "${FACILITY_NAME}" \
  "${FACILITY_CODE}" \
  "${FACILITY_TIER}" \
  "${FACILITY_COUNTY}" \
  "${FACILITY_SUB_COUNTY}" \
  "${FACILITY_PROVIDER_ID}" \
  "${ADMIN_EMAIL}" \
  "${ADMIN_PASSWORD_INPUT}"
activate_bundled_rulepack
run_service_health_checks
print_registration_payload

