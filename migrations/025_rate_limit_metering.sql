-- 025_rate_limit_metering.sql
--
-- Item 6d: per-tenant + per-key rate limiting and usage metering. Both tables
-- are tenant-scoped and fall under the SAME RLS model as every other tenant
-- table (ENABLE + FORCE + USING/WITH CHECK on app.current_tenant_id()), so the
-- synchronous request path reads quota and writes usage on the claimflow_app
-- role inside runWithTenant — never a privileged cross-tenant path. Runs on the
-- owner/migration path (scripts/migrate.sh).

-- ---------------------------------------------------------------------------
-- usage_counters: the metering / billing source of truth.
--   One row per (tenant, principal, window_start, route_class). `principal_id`
--   is the API key / OAuth client id for machine traffic, or NULL for human
--   (JWT) traffic counted at the tenant level. Counts are incremented
--   atomically via INSERT ... ON CONFLICT ... DO UPDATE SET count = count + n,
--   so parallel requests never double- or lost-count.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_counters (
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    -- API key id / OAuth client id for machine traffic; NULL = human/JWT traffic.
    principal_id  TEXT NOT NULL DEFAULT '-',
    -- Coarse route class for metering (e.g. 'default', 'audit', 'export').
    route_class   TEXT NOT NULL DEFAULT 'default',
    -- Start of the fixed window this row meters (truncated to the window size).
    window_start  TIMESTAMPTZ NOT NULL,
    request_count BIGINT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, principal_id, route_class, window_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_tenant_window
  ON usage_counters(tenant_id, window_start DESC);

-- ---------------------------------------------------------------------------
-- rate_limit_policies: optional per-tenant / per-principal overrides of the
--   default RPM. A NULL principal_id row is the tenant-wide default; a row with
--   a principal_id overrides for that key/client. Absent => global default RPM.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_policies (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    principal_id  TEXT,                 -- NULL = tenant-wide default
    route_class   TEXT NOT NULL DEFAULT 'default',
    max_per_minute INTEGER NOT NULL CHECK (max_per_minute > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One policy per (tenant, principal, route_class); COALESCE principal to '-' for
-- the uniqueness of the tenant-wide default.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rate_limit_policies_scope
  ON rate_limit_policies(tenant_id, COALESCE(principal_id, '-'), route_class);

-- ---------------------------------------------------------------------------
-- Grants + RLS (identical model to migration 024).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_counters, rate_limit_policies TO claimflow_app;

DO $mig$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['usage_counters','rate_limit_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant_isolation', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO claimflow_app '
      || 'USING (tenant_id = app.current_tenant_id()) '
      || 'WITH CHECK (tenant_id = app.current_tenant_id())',
      tbl || '_tenant_isolation', tbl
    );
  END LOOP;
END
$mig$;
