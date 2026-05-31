-- 016_payers.sql
--
-- Multi-payer catalog. Payers (SHA, AAR, Jubilee, CIC, ...) are global reference
-- data shared across all tenants — like icd_codes / sha_service_codes — so this
-- table is intentionally NOT tenant-scoped. A claim references a payer; the audit
-- pipeline resolves that payer's active rulepack version.

DO $$ BEGIN
    CREATE TYPE payer_status AS ENUM ('ACTIVE', 'COMING_SOON', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS payers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    short_name       TEXT,
    status           payer_status NOT NULL DEFAULT 'COMING_SOON',
    rulepack_version TEXT,
    country_code     TEXT NOT NULL DEFAULT 'KE',
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payers_status ON payers(status, sort_order);

-- Seed the launch catalog. SHA is live (rulepack v1.0.0 ships in-repo); the
-- private insurers are listed as COMING_SOON so the UI dropdown can show them
-- before their rulepacks are authored — without silently producing weak audits.
INSERT INTO payers (slug, name, short_name, status, rulepack_version, country_code, sort_order)
VALUES
    ('sha',     'Social Health Authority',  'SHA',     'ACTIVE',      '1.0.0', 'KE', 1),
    ('aar',     'AAR Insurance Kenya',      'AAR',     'COMING_SOON', NULL,    'KE', 2),
    ('jubilee', 'Jubilee Health Insurance', 'Jubilee', 'COMING_SOON', NULL,    'KE', 3),
    ('cic',     'CIC Insurance Group',      'CIC',     'COMING_SOON', NULL,    'KE', 4)
ON CONFLICT (slug) DO NOTHING;

-- Associate claims with a payer. Nullable for backward compatibility: a NULL
-- payer_id is treated as the default SHA payer by the audit pipeline.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_id UUID REFERENCES payers(id);
CREATE INDEX IF NOT EXISTS idx_claims_payer ON claims(tenant_id, payer_id);
