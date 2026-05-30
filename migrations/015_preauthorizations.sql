-- 015_preauthorizations.sql

DO $$ BEGIN
    CREATE TYPE preauthorization_status AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED', 'USED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS preauthorizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    facility_id     UUID NOT NULL REFERENCES facilities(id),
    preauth_number  TEXT NOT NULL,
    patient_sha_id  TEXT NOT NULL,
    status          preauthorization_status NOT NULL DEFAULT 'ACTIVE',
    valid_from      DATE,
    valid_to        DATE NOT NULL,
    approved_at     TIMESTAMPTZ,
    source          TEXT NOT NULL DEFAULT 'MANUAL_ENTRY',
    metadata_json   JSONB NOT NULL DEFAULT '{}',
    created_by      UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, preauth_number),
    CONSTRAINT chk_preauth_valid_window CHECK (valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE IF NOT EXISTS preauthorization_service_codes (
    preauthorization_id UUID NOT NULL REFERENCES preauthorizations(id) ON DELETE CASCADE,
    sha_service_code    TEXT NOT NULL,
    quantity_authorized INTEGER,
    max_amount_kes      NUMERIC(12,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (preauthorization_id, sha_service_code),
    CONSTRAINT chk_preauth_quantity_positive CHECK (quantity_authorized IS NULL OR quantity_authorized > 0),
    CONSTRAINT chk_preauth_amount_non_negative CHECK (max_amount_kes IS NULL OR max_amount_kes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_preauth_tenant_number ON preauthorizations(tenant_id, preauth_number);
CREATE INDEX IF NOT EXISTS idx_preauth_tenant_patient ON preauthorizations(tenant_id, patient_sha_id);
CREATE INDEX IF NOT EXISTS idx_preauth_tenant_valid_to ON preauthorizations(tenant_id, valid_to);

DO $$ BEGIN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PREAUTH_REGISTERED';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PREAUTH_UPDATED';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
