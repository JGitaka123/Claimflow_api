-- 019_webhooks.sql
--
-- Signed webhook event delivery (item 4). Tenant-scoped endpoints + a durable
-- delivery log with retry/backoff driven by next_attempt_at.

DO $$ BEGIN
    CREATE TYPE webhook_delivery_status AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'EXHAUSTED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(id),
    url          TEXT NOT NULL,
    secret       TEXT NOT NULL,
    events       TEXT[] NOT NULL DEFAULT '{}',
    is_active    BOOLEAN NOT NULL DEFAULT true,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant ON webhook_endpoints(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID NOT NULL REFERENCES tenants(id),
    endpoint_id      UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event_type       TEXT NOT NULL,
    event_id         UUID NOT NULL DEFAULT gen_random_uuid(),
    payload_json     JSONB NOT NULL,
    status           webhook_delivery_status NOT NULL DEFAULT 'PENDING',
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 6,
    response_status  INTEGER,
    error            TEXT,
    next_attempt_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant ON webhook_deliveries(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
