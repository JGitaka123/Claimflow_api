-- 011_sync.sql

DO $$ BEGIN
    CREATE TYPE sync_direction AS ENUM ('UP', 'DOWN');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE sync_payload_type AS ENUM ('METRICS', 'RULEPACK', 'MODEL', 'SOFTWARE', 'LICENSE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE sync_status AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS sync_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction       sync_direction NOT NULL,
    payload_type    sync_payload_type NOT NULL,
    status          sync_status NOT NULL DEFAULT 'PENDING',
    payload_ref     TEXT,
    payload_checksum TEXT,
    error_message   TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    attempted_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS license_state (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     UUID NOT NULL REFERENCES facilities(id),
    tier            TEXT NOT NULL DEFAULT 'FREE',
    license_token   TEXT NOT NULL,
    feature_flags   JSONB NOT NULL DEFAULT '{}',
    expires_at      TIMESTAMPTZ NOT NULL,
    last_validated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    offline_grace_until TIMESTAMPTZ,
    UNIQUE(facility_id)
);
