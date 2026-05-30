-- 007_audits.sql

DO $$ BEGIN
    CREATE TYPE audit_decision AS ENUM ('PASSED', 'FAILED', 'WARNING');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE rule_result_status AS ENUM ('PASS', 'FAIL', 'WARNING', 'INCOMPLETE', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS audit_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id            UUID NOT NULL REFERENCES claims(id),
    user_id             UUID NOT NULL REFERENCES users(id),
    rulepack_version    TEXT NOT NULL,
    rulepack_checksum   TEXT NOT NULL,
    decision            audit_decision,
    total_rules         INTEGER NOT NULL DEFAULT 0,
    passed_count        INTEGER NOT NULL DEFAULT 0,
    failed_count        INTEGER NOT NULL DEFAULT 0,
    warning_count       INTEGER NOT NULL DEFAULT 0,
    incomplete_count    INTEGER NOT NULL DEFAULT 0,
    skipped_count       INTEGER NOT NULL DEFAULT 0,
    deterministic_score REAL,
    ml_quality_score    REAL,
    fix_report_md       TEXT,
    fix_report_pdf_path TEXT,
    execution_time_ms   INTEGER,
    is_batch            BOOLEAN NOT NULL DEFAULT false,
    batch_job_id        UUID,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS rule_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audit_session_id UUID NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
    rule_id         TEXT NOT NULL,
    category        rule_category NOT NULL,
    severity        rule_severity NOT NULL,
    result          rule_result_status NOT NULL,
    message         TEXT NOT NULL,
    remediation     TEXT,
    evidence_json   JSONB,
    execution_time_ms INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add FK from claims to audit_sessions (deferred to avoid circular dependency)
DO $$ BEGIN
    ALTER TABLE claims ADD CONSTRAINT fk_claims_last_audit
        FOREIGN KEY (last_audit_session_id) REFERENCES audit_sessions(id);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_sessions_claim ON audit_sessions(claim_id);
CREATE INDEX IF NOT EXISTS idx_audit_sessions_decision ON audit_sessions(decision);
CREATE INDEX IF NOT EXISTS idx_rule_results_session ON rule_results(audit_session_id);
CREATE INDEX IF NOT EXISTS idx_rule_results_rule ON rule_results(rule_id, result);
