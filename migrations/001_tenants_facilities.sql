-- 001_tenants_facilities.sql
-- Tenancy and facility management

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facilities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    name                TEXT NOT NULL,
    sha_facility_code   TEXT NOT NULL,
    sha_provider_id     TEXT,
    mfl_code            TEXT,
    tier_level          TEXT NOT NULL,
    license_status      TEXT NOT NULL DEFAULT 'ACTIVE',
    county              TEXT NOT NULL,
    sub_county          TEXT,
    facility_type       TEXT NOT NULL DEFAULT 'HOSPITAL',
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, sha_facility_code)
);

CREATE INDEX IF NOT EXISTS idx_facilities_tenant ON facilities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_facilities_sha_code ON facilities(sha_facility_code);
