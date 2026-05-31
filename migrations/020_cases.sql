-- 020_cases.sql
--
-- Investigation case management (item 5). Cases group flagged claims for review,
-- carry a status lifecycle, and record every mutation in an append-only
-- case_events audit trail.

DO $$ BEGIN
    CREATE TYPE case_status AS ENUM ('OPEN', 'INVESTIGATING', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE case_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS investigation_cases (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    title        TEXT NOT NULL,
    description  TEXT,
    status       case_status NOT NULL DEFAULT 'OPEN',
    priority     case_priority NOT NULL DEFAULT 'MEDIUM',
    assigned_to  UUID REFERENCES users(id),
    resolution   TEXT,
    created_by   UUID NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cases_tenant_status ON investigation_cases(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_cases_assigned ON investigation_cases(tenant_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_cases_created ON investigation_cases(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS case_claims (
    case_id    UUID NOT NULL REFERENCES investigation_cases(id) ON DELETE CASCADE,
    claim_id   UUID NOT NULL REFERENCES claims(id),
    tenant_id  UUID NOT NULL REFERENCES tenants(id),
    linked_by  UUID NOT NULL REFERENCES users(id),
    linked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (case_id, claim_id)
);

CREATE INDEX IF NOT EXISTS idx_case_claims_claim ON case_claims(claim_id);

-- Append-only audit trail for case mutations.
CREATE TABLE IF NOT EXISTS case_events (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    case_id      UUID NOT NULL REFERENCES investigation_cases(id) ON DELETE CASCADE,
    user_id      UUID REFERENCES users(id),
    action       TEXT NOT NULL,
    detail_json  JSONB NOT NULL DEFAULT '{}',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_id, created_at);
