#!/usr/bin/env bash
#
# seed-sandbox.sh — provision a self-contained SANDBOX for SDK / API evaluation.
#
# Creates (idempotently): a `sandbox` tenant + facility + one human owner user,
# ONE API key and ONE OAuth2 client (both with fixed, well-known SYNTHETIC
# credentials so the quickstart is reproducible), and a handful of SYNTHETIC
# claims. There is NO real PHI anywhere here — patient identifiers are obviously
# fake (`SANDBOX-…`). Pair with docs/sandbox-quickstart.md.
#
# Usage: scripts/seed-sandbox.sh   (re-runnable; upserts everything)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/docker/.env"

log() { printf "[sandbox] %s\n" "$*"; }
fail() { printf "[sandbox] ERROR: %s\n" "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is required"
[ -f "${ENV_FILE}" ] || fail "Missing ${ENV_FILE}. Run scripts/setup.sh first."

# ---- fixed SYNTHETIC sandbox credentials (safe to publish; sandbox-only) ----
SANDBOX_TENANT_SLUG="sandbox"
SANDBOX_USER_EMAIL="sandbox@claimflow.test"
SANDBOX_USER_PASSWORD="Sandbox-Demo-Pass-12!"
# bcrypt(SANDBOX_USER_PASSWORD) — the account owns the keys/claims below.
SANDBOX_USER_PWHASH='$2a$10$8hx5hzRtTTpA/6.L2qnpTOYL.XHCKhAaiE09Xk060k.ovYlwj4I8O'

SANDBOX_API_KEY="cf_5a4d6b0e_5e7b3c9a1f2d4e6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b"
SANDBOX_API_KEY_PREFIX="5a4d6b0e"
SANDBOX_CLIENT_ID="cf-sandbox-client"
SANDBOX_CLIENT_SECRET="cf_sandbox_secret_3f1e5d7c9b1a3e5d7c9b1a3e5d7c9b1a"

KEY_HASH="$(printf '%s' "${SANDBOX_API_KEY}" | sha256sum | awk '{print $1}')"
SECRET_HASH="$(printf '%s' "${SANDBOX_CLIENT_SECRET}" | sha256sum | awk '{print $1}')"

psql_exec() {
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d claimflow "$@"
}

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres >/dev/null

log "Seeding sandbox tenant, facility, owner, machine credentials and synthetic claims"
# One statement; chained data-modifying CTEs run exactly once each (even those
# not referenced), so the whole graph is upserted atomically and idempotently.
psql_exec <<SQL
WITH t AS (
  INSERT INTO tenants (name, slug, is_active)
  VALUES ('ClaimFlow Sandbox', '${SANDBOX_TENANT_SLUG}', true)
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id AS tenant_id
),
f AS (
  INSERT INTO facilities (tenant_id, name, sha_facility_code, tier_level, county, facility_type)
  SELECT tenant_id, 'Sandbox Demo Hospital', 'SANDBOX-FID-0001', 'LEVEL_4', 'Nairobi', 'HOSPITAL' FROM t
  ON CONFLICT (tenant_id, sha_facility_code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id AS facility_id, tenant_id
),
u AS (
  INSERT INTO users (tenant_id, facility_id, email, display_name, password_hash, role, is_active, must_change_password)
  SELECT f.tenant_id, f.facility_id, '${SANDBOX_USER_EMAIL}', 'Sandbox Owner',
         '${SANDBOX_USER_PWHASH}', 'admin', true, false FROM f
  ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
  RETURNING id AS user_id, tenant_id, facility_id
),
k AS (
  INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, scopes, created_by)
  SELECT u.tenant_id, 'Sandbox API key', '${SANDBOX_API_KEY_PREFIX}', '${KEY_HASH}',
         ARRAY['claim:create','audit:trigger','export:evidence','dashboard:view']::text[], u.user_id FROM u
  ON CONFLICT (key_prefix) DO UPDATE
    SET key_hash = EXCLUDED.key_hash, scopes = EXCLUDED.scopes, revoked_at = NULL
  RETURNING id
),
oc AS (
  INSERT INTO oauth_clients (tenant_id, name, client_id, client_secret_hash, scopes, created_by)
  SELECT u.tenant_id, 'Sandbox OAuth client', '${SANDBOX_CLIENT_ID}', '${SECRET_HASH}',
         ARRAY['claim:create','audit:trigger','export:evidence','dashboard:view']::text[], u.user_id FROM u
  ON CONFLICT (client_id) DO UPDATE
    SET client_secret_hash = EXCLUDED.client_secret_hash, scopes = EXCLUDED.scopes, revoked_at = NULL
  RETURNING id
),
del AS (
  DELETE FROM claims
   WHERE tenant_id = (SELECT tenant_id FROM u) AND hmis_ref LIKE 'SANDBOX-%'
  RETURNING id
)
-- Synthetic claims (clearly fake; no real PHI).
INSERT INTO claims (
  tenant_id, facility_id, payer_id, patient_sha_id, patient_name_enc, patient_national_id_enc,
  hmis_ref, claim_type, visit_type, admission_date, primary_diagnosis_code, sha_benefit_package, status, created_by)
SELECT
  u.tenant_id,
  u.facility_id,
  (SELECT id FROM payers WHERE slug = 'sha'),
  format('SANDBOX-SHA-%04s', gs),
  format('SANDBOX Test Patient %s', gs),
  format('SANDBOX-ID-%04s', gs),
  format('SANDBOX-%04s', gs),
  (ARRAY['OUTPATIENT','INPATIENT','MATERNITY']::claim_type[])[((gs - 1) % 3) + 1],
  CASE WHEN gs % 2 = 0 THEN 'IP'::visit_type ELSE 'OP'::visit_type END,
  CURRENT_DATE - (gs || ' days')::interval,
  (ARRAY['GB61','BA01','CA40']::text[])[((gs - 1) % 3) + 1],
  'SHA-BASE',
  'DRAFT'::claim_status,
  u.user_id
FROM u CROSS JOIN generate_series(1, 5) AS gs;
SQL

cat <<EOF

[sandbox] Done. Synthetic sandbox is ready.

  Tenant slug      : ${SANDBOX_TENANT_SLUG}
  Owner login      : ${SANDBOX_USER_EMAIL} / ${SANDBOX_USER_PASSWORD}

  API key          : ${SANDBOX_API_KEY}
  OAuth client_id  : ${SANDBOX_CLIENT_ID}
  OAuth secret     : ${SANDBOX_CLIENT_SECRET}

  Scopes           : claim:create, audit:trigger, export:evidence, dashboard:view

These are SYNTHETIC sandbox credentials — safe to share, never use in production.
Next: docs/sandbox-quickstart.md
EOF
