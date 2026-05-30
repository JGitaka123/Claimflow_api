-- 006_rulepacks.sql

DO $$ BEGIN
    CREATE TYPE rule_severity AS ENUM ('HARD_STOP', 'MAJOR', 'MINOR', 'INFO');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE rule_category AS ENUM ('IDENTITY', 'DOCUMENTATION', 'CLINICAL', 'AUTHORIZATION', 'FINANCIAL', 'STRUCTURAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS rulepacks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_semver  TEXT NOT NULL UNIQUE,
    version_major   INTEGER NOT NULL,
    version_minor   INTEGER NOT NULL,
    version_patch   INTEGER NOT NULL,
    sha_policy_version TEXT,
    description     TEXT,
    rule_count      INTEGER NOT NULL DEFAULT 0,
    checksum        TEXT NOT NULL,
    is_activated    BOOLEAN NOT NULL DEFAULT false,
    activated_at    TIMESTAMPTZ,
    activated_by    UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rulepack_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rulepack_id     UUID NOT NULL REFERENCES rulepacks(id) ON DELETE CASCADE,
    rule_id         TEXT NOT NULL,
    category        rule_category NOT NULL,
    severity        rule_severity NOT NULL,
    logic_key       TEXT NOT NULL,
    params_json     JSONB NOT NULL DEFAULT '{}',
    applies_to      JSONB NOT NULL DEFAULT '["ALL"]',
    message_i18n    JSONB NOT NULL,
    remediation_i18n JSONB NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(rulepack_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_rulepacks_active ON rulepacks(is_activated, version_major DESC, version_minor DESC, version_patch DESC);
CREATE INDEX IF NOT EXISTS idx_rulepack_rules_pack ON rulepack_rules(rulepack_id);
CREATE INDEX IF NOT EXISTS idx_rulepack_rules_category ON rulepack_rules(rulepack_id, category, sort_order);
