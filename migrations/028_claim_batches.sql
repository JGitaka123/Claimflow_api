-- 028_claim_batches.sql
--
-- Async bulk claim submission + scoring (POST /v1/claims/batch). Two tenant-scoped
-- tables under the SAME RLS model as every other tenant table (ENABLE + FORCE +
-- the standard app.current_tenant_id() policy), so the submit path and the worker
-- (runWithTenant) read/write only their own tenant's rows on the claimflow_app role.
-- Additive; no destructive change.

CREATE TABLE IF NOT EXISTS claim_batches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    status          TEXT NOT NULL DEFAULT 'QUEUED',
    total_claims    INTEGER NOT NULL,
    processed_count INTEGER NOT NULL DEFAULT 0,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Composite key so child items can FK on (batch_id, tenant_id).
    UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_batches_tenant ON claim_batches(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS claim_batch_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id      UUID NOT NULL,
    tenant_id     UUID NOT NULL,
    item_index    INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'QUEUED',   -- QUEUED | SCORED | FAILED
    claim_id      UUID,
    -- Closed, public-safe ClaimScoreResult only (NO rule internals).
    score_json    JSONB,
    error_code    TEXT,
    error_message TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Child tenant_id can never diverge from the batch's tenant.
    CONSTRAINT fk_claim_batch_items_batch
      FOREIGN KEY (batch_id, tenant_id) REFERENCES claim_batches(id, tenant_id) ON DELETE CASCADE,
    UNIQUE (batch_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_claim_batch_items_batch ON claim_batch_items(tenant_id, batch_id, item_index);

-- Grants + RLS (identical model to migration 024/025).
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_batches, claim_batch_items TO claimflow_app;

DO $mig$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['claim_batches','claim_batch_items'] LOOP
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
