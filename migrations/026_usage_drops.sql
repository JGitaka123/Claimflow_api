-- 026_usage_drops.sql
--
-- "Loud fail-open" for the usage-metering path. When the tenant-scoped counter
-- store errors, the request is allowed through (availability > strict metering),
-- but the dropped (unmetered) request is recorded HERE so the gap is measurable
-- for billing reconciliation and so a counter-store outage / bypass-probe is
-- visible rather than silent.
--
-- This table is written on the PRIVILEGED (owner) pool, on the error path only:
-- the tenant-scoped path just failed, so re-using it would likely fail too. It
-- carries tenant_id as DATA (telemetry), is never read on the request path, and
-- holds only counts (no PHI). It is therefore intentionally NOT app-role-granted
-- and NOT under tenant RLS — same disposition as outbox_events/sync_events.

CREATE TABLE IF NOT EXISTS usage_drops (
    tenant_id     UUID NOT NULL,
    principal_id  TEXT NOT NULL DEFAULT '-',
    route_class   TEXT NOT NULL DEFAULT 'default',
    window_start  TIMESTAMPTZ NOT NULL,
    -- Number of requests allowed through unmetered during a store outage.
    dropped_count BIGINT NOT NULL DEFAULT 0,
    reason        TEXT NOT NULL DEFAULT 'metering_store_error',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, principal_id, route_class, window_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_drops_window ON usage_drops(window_start DESC);

-- Explicitly NOT granted to claimflow_app: written only via the privileged pool
-- on the metering error path. (rls-guard ignores it because the app role has no
-- grants on it.)
