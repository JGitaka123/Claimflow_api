-- 022_oauth_clients.sql
--
-- OAuth2 client-credentials clients for enterprise machine access (item 6b).
-- A client exchanges client_id + client_secret at POST /v1/oauth/token for a
-- short-lived RS256 JWT carrying tenant + scope claims (verified by the auth
-- plugin, reusing the existing JWT key infrastructure).
--
-- Only the SHA-256 hash of the client secret is stored; the plaintext secret is
-- shown once at creation. Clients carry explicit scopes (a subset of the RBAC
-- permissions) and are revocable. Issued tokens are stateless and remain valid
-- until they expire (short TTL); revoking a client stops new tokens being issued.

CREATE TABLE IF NOT EXISTS oauth_clients (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(id),
    name               TEXT NOT NULL,
    client_id          TEXT NOT NULL,
    client_secret_hash TEXT NOT NULL,
    scopes             TEXT[] NOT NULL DEFAULT '{}',
    created_by         UUID NOT NULL REFERENCES users(id),
    last_used_at       TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_tenant ON oauth_clients(tenant_id, revoked_at);
