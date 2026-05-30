-- 003_claims.sql

DO $$ BEGIN
    CREATE TYPE claim_status AS ENUM (
        'DRAFT', 'DOCUMENTS_UPLOADED', 'PROCESSING', 'AUDIT_COMPLETE',
        'PASSED', 'FAILED', 'WARNING', 'OFFICER_REVIEW',
        'CORRECTIONS_IN_PROGRESS', 'OVERRIDE_PENDING', 'OVERRIDE_APPROVED',
        'READY_FOR_SUBMISSION', 'SUBMITTED'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE claim_type AS ENUM ('OUTPATIENT', 'INPATIENT', 'MATERNITY', 'DENTAL', 'OPTICAL', 'MENTAL_HEALTH', 'RENAL', 'SURGICAL', 'EMERGENCY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE visit_type AS ENUM ('OP', 'IP', 'DAYCASE', 'EMERGENCY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS claims (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    facility_id     UUID NOT NULL REFERENCES facilities(id),
    patient_sha_id  TEXT,
    patient_name_enc TEXT,
    patient_national_id_enc TEXT,
    hmis_ref        TEXT,
    claim_type      claim_type NOT NULL,
    visit_type      visit_type NOT NULL DEFAULT 'OP',
    admission_date  DATE NOT NULL,
    discharge_date  DATE,
    primary_diagnosis_code TEXT,
    sha_benefit_package TEXT,
    preauth_number  TEXT,
    accommodation_type TEXT,
    patient_disposition TEXT,
    hospital_approved_total NUMERIC(12,2),
    status          claim_status NOT NULL DEFAULT 'DRAFT',
    version         INTEGER NOT NULL DEFAULT 1,
    last_audit_session_id UUID,
    dedup_hash      TEXT,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claim_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    line_number     INTEGER NOT NULL,
    sha_service_code TEXT NOT NULL,
    description     TEXT NOT NULL,
    icd_code        TEXT,
    procedure_code  TEXT,
    case_code       TEXT,
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      NUMERIC(12,2) NOT NULL,
    total_amount    NUMERIC(12,2) NOT NULL,
    bill_amount     NUMERIC(12,2),
    preauth_number  TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    validation_notes TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(claim_id, line_number)
);

CREATE INDEX IF NOT EXISTS idx_claims_tenant ON claims(tenant_id);
CREATE INDEX IF NOT EXISTS idx_claims_facility ON claims(facility_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_patient ON claims(tenant_id, patient_sha_id);
CREATE INDEX IF NOT EXISTS idx_claims_dedup ON claims(dedup_hash);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claim_lines_claim ON claim_lines(claim_id);
