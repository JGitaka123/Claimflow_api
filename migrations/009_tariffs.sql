-- 009_tariffs.sql

CREATE TABLE IF NOT EXISTS tariff_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version         TEXT NOT NULL UNIQUE,
    description     TEXT,
    source_url      TEXT,
    published_date  DATE NOT NULL,
    checksum        TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT false,
    activated_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tariffs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tariff_version_id UUID NOT NULL REFERENCES tariff_versions(id) ON DELETE CASCADE,
    sha_service_code TEXT NOT NULL,
    description     TEXT NOT NULL,
    benefit_package TEXT NOT NULL,
    facility_tier   TEXT,
    claim_type      claim_type,
    max_amount_kes  NUMERIC(12,2) NOT NULL,
    requires_preauth BOOLEAN NOT NULL DEFAULT false,
    effective_from  DATE NOT NULL,
    effective_to    DATE
);

CREATE INDEX IF NOT EXISTS idx_tariffs_version ON tariffs(tariff_version_id);
CREATE INDEX IF NOT EXISTS idx_tariffs_code ON tariffs(sha_service_code, benefit_package);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tariffs_unique_key
    ON tariffs(tariff_version_id, sha_service_code, benefit_package, COALESCE(facility_tier, ''));
