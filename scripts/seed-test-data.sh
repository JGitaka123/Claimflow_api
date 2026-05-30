#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.yml"
ENV_FILE="${REPO_ROOT}/docker/.env"

log() {
  printf "[seed] %s\n" "$*"
}

fail() {
  printf "[seed] ERROR: %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command not found: $1"
  fi
}

compose_exec_psql() {
  local sql="$1"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U claimflow -d claimflow -c "${sql}"
}

require_cmd docker
[ -f "${ENV_FILE}" ] || fail "Missing docker env file: ${ENV_FILE}. Run scripts/setup.sh first."

docker compose version >/dev/null 2>&1 || fail "docker compose plugin is required"

docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d postgres >/dev/null

log "Clearing existing training claims"
compose_exec_psql "
  DELETE FROM claims
  WHERE hmis_ref LIKE 'TRAINING-%';
"

log "Creating 20 training claims with documents and extraction hints"
compose_exec_psql "
  WITH context AS (
    SELECT
      t.id AS tenant_id,
      f.id AS facility_id,
      u.id AS user_id
    FROM tenants t
    JOIN facilities f ON f.tenant_id = t.id
    JOIN users u ON u.tenant_id = t.id
    WHERE u.role IN ('super_admin', 'admin', 'claims_officer')
      AND u.is_active = true
    ORDER BY u.created_at ASC
    LIMIT 1
  ), seeded_claims AS (
    INSERT INTO claims (
      tenant_id,
      facility_id,
      patient_sha_id,
      patient_name_enc,
      patient_national_id_enc,
      hmis_ref,
      claim_type,
      visit_type,
      admission_date,
      discharge_date,
      primary_diagnosis_code,
      sha_benefit_package,
      status,
      created_by
    )
    SELECT
      c.tenant_id,
      c.facility_id,
      format('TEST-SHA-%04s', gs),
      format('Training Patient %s', gs),
      format('TEST-ID-%04s', gs),
      format('TRAINING-%04s', gs),
      (ARRAY['OUTPATIENT','INPATIENT','MATERNITY','DENTAL','OPTICAL','MENTAL_HEALTH','RENAL','SURGICAL','EMERGENCY'])[((gs - 1) % 9) + 1]::claim_type,
      CASE
        WHEN gs % 5 = 0 THEN 'EMERGENCY'::visit_type
        WHEN gs % 2 = 0 THEN 'IP'::visit_type
        ELSE 'OP'::visit_type
      END,
      CURRENT_DATE - (gs || ' days')::interval,
      CASE WHEN gs % 2 = 0 THEN CURRENT_DATE - ((gs - 2) || ' days')::interval ELSE NULL END,
      CASE
        WHEN gs % 4 = 0 THEN 'GB61'
        WHEN gs % 4 = 1 THEN 'BA01'
        WHEN gs % 4 = 2 THEN 'CA40'
        ELSE 'DA62'
      END,
      'SHA-BASE',
      CASE
        WHEN gs % 3 = 0 THEN 'DOCUMENTS_UPLOADED'::claim_status
        ELSE 'DRAFT'::claim_status
      END,
      c.user_id
    FROM context c
    CROSS JOIN generate_series(1, 20) AS gs
    RETURNING id, created_by, status
  ), seeded_lines AS (
    INSERT INTO claim_lines (
      claim_id,
      line_number,
      sha_service_code,
      description,
      icd_code,
      quantity,
      unit_price,
      total_amount,
      bill_amount,
      status
    )
    SELECT
      sc.id,
      ln.line_number,
      ln.sha_service_code,
      ln.description,
      ln.icd_code,
      ln.quantity,
      ln.unit_price,
      ln.total_amount,
      ln.total_amount,
      'PENDING'
    FROM seeded_claims sc
    CROSS JOIN LATERAL (
      VALUES
        (1, 'SVC-OP-001', 'Consultation fee', 'CA40', 1, 1200::numeric, 1200::numeric),
        (2, 'SVC-LAB-001', 'Laboratory diagnostics', 'BA01', 1, 1800::numeric, 1800::numeric)
    ) AS ln(line_number, sha_service_code, description, icd_code, quantity, unit_price, total_amount)
    RETURNING claim_id
  ), seeded_docs AS (
    INSERT INTO documents (
      claim_id,
      doc_type,
      processing_route,
      mime_type,
      original_filename,
      page_count,
      file_size_bytes,
      storage_path,
      sha256,
      processing_status,
      uploaded_by
    )
    SELECT
      sc.id,
      'SHA_CLAIM_FORM_OP'::doc_type,
      'FULL_OCR_EXTRACT'::doc_processing_route,
      'application/pdf',
      format('training-claim-%s.pdf', row_number() OVER (ORDER BY sc.id)),
      1,
      102400,
      format('training/%s/claim.pdf', sc.id),
      repeat(md5(sc.id::text), 2),
      'COMPLETED'::doc_processing_status,
      sc.created_by
    FROM seeded_claims sc
    WHERE sc.status = 'DOCUMENTS_UPLOADED'::claim_status
    RETURNING id, claim_id
  ), seeded_doc_pages AS (
    INSERT INTO document_pages (
      document_id,
      page_number,
      status,
      ocr_engine_used,
      overall_confidence,
      image_quality_score,
      processed_at
    )
    SELECT
      sd.id,
      1,
      'COMPLETED'::doc_processing_status,
      'tesseract',
      0.92,
      0.89,
      now()
    FROM seeded_docs sd
    RETURNING document_id, page_number
  )
  INSERT INTO extracted_fields (
    claim_id,
    document_id,
    page_number,
    field_key,
    field_value,
    confidence,
    confidence_tier,
    source,
    needs_review,
    reviewed
  )
  SELECT
    sd.claim_id,
    sd.id,
    1,
    ef.field_key,
    ef.field_value,
    ef.confidence,
    ef.confidence_tier::field_confidence_tier,
    'OCR',
    ef.needs_review,
    false
  FROM seeded_docs sd
  CROSS JOIN LATERAL (
    VALUES
      ('patient_name', 'Training Patient', 0.95, 'HIGH', false),
      ('patient_sha_id', 'TEST-SHA', 0.91, 'HIGH', false),
      ('primary_diagnosis_code', CASE WHEN random() > 0.5 THEN 'GB61' ELSE 'GB6I' END, 0.62, 'MEDIUM', true),
      ('physician_signature_present', CASE WHEN random() > 0.3 THEN 'true' ELSE 'false' END, 0.55, 'LOW', true)
  ) AS ef(field_key, field_value, confidence, confidence_tier, needs_review);
"

log "Training data seeded successfully"
