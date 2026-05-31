-- 021_api_keys.sql
--
-- Tenant-scoped API keys for machine access (item 6a). Only the SHA-256 hash of
-- the full key is stored; the plaintext is shown once at creation. Keys carry
-- explicit scopes (a subset of the RBAC permissions) and can be revoked/expired.

CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    scopes       TEXT[] NOT NULL DEFAULT '{}',
    created_by   UUID NOT NULL REFERENCES users(id),
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id, revoked_at);
