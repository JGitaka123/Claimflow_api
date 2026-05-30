-- 008_audit_trail.sql

DO $$ BEGIN
    CREATE TYPE audit_action AS ENUM (
        'CLAIM_CREATED', 'CLAIM_UPDATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED',
        'DOCUMENT_DOWNLOADED',
        'AUDIT_STARTED', 'AUDIT_COMPLETED', 'FIELD_CORRECTED',
        'OVERRIDE_REQUESTED', 'OVERRIDE_APPROVED', 'OVERRIDE_REJECTED',
        'CLAIM_STATE_CHANGED', 'CLAIM_EXPORTED',
        'BATCH_AUDIT_STARTED', 'BATCH_AUDIT_COMPLETED',
        'USER_LOGIN', 'USER_LOGOUT', 'USER_MFA_VERIFIED', 'USER_LOCKED',
        'RULEPACK_ACTIVATED', 'RULEPACK_ROLLED_BACK',
        'SYSTEM_DEGRADED_MODE_ENTERED', 'SYSTEM_DEGRADED_MODE_EXITED'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'DOCUMENT_DOWNLOADED';
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS audit_trail (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    claim_id        UUID,
    user_id         UUID REFERENCES users(id),
    action          audit_action NOT NULL,
    from_state      claim_status,
    to_state        claim_status,
    detail_json     JSONB NOT NULL DEFAULT '{}',
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION prevent_audit_trail_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_trail is append-only. UPDATE and DELETE are prohibited.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_update_audit_trail ON audit_trail;
CREATE TRIGGER no_update_audit_trail
    BEFORE UPDATE OR DELETE ON audit_trail
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_trail_modification();

CREATE INDEX IF NOT EXISTS idx_audit_trail_tenant ON audit_trail(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_claim ON audit_trail(claim_id, created_at DESC) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_trail_user ON audit_trail(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_trail_action ON audit_trail(action, created_at DESC);
