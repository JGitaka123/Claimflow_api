-- 012_icd_codes.sql

CREATE TABLE IF NOT EXISTS icd_codes (
    code            TEXT PRIMARY KEY,
    version         TEXT NOT NULL DEFAULT '11',
    title_en        TEXT NOT NULL,
    title_sw        TEXT,
    chapter         TEXT,
    block           TEXT,
    is_leaf         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sha_service_codes (
    code            TEXT PRIMARY KEY,
    description     TEXT NOT NULL,
    category        TEXT,
    benefit_packages JSONB NOT NULL DEFAULT '["SHIF"]',
    requires_preauth BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_icd_codes_chapter ON icd_codes(chapter);
CREATE INDEX IF NOT EXISTS idx_sha_codes_category ON sha_service_codes(category);
