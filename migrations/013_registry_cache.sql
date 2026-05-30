-- 013_registry_cache.sql

CREATE TABLE IF NOT EXISTS registry_cache (
    cache_key       TEXT PRIMARY KEY,
    registry_type   TEXT NOT NULL,
    response_json   JSONB NOT NULL,
    is_valid        BOOLEAN NOT NULL DEFAULT true,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registry_cache_expires ON registry_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_registry_cache_type ON registry_cache(registry_type);
