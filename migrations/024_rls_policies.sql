-- 024_rls_policies.sql
--
-- Item 6c, part 2 of 2: enable + FORCE Row-Level Security and install the
-- tenant-isolation policies. Runs on the privileged/owner path. Depends on 023
-- (the claimflow_app role + denormalized tenant_id columns).
--
-- Fail-closed model: the policies read the tenant via app.current_tenant_id(),
-- which returns NULL for an unset, empty, or non-UUID GUC. A NULL comparison is
-- never true, so an un-scoped (or malformed) connection sees zero rows and can
-- write nothing — it denies, never default-allows.

-- ---------------------------------------------------------------------------
-- Safe tenant accessor: NULL on unset / empty / invalid (no error-bypass).
-- Lives in an `app` schema (kept out of public); the app role may execute it.
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO claimflow_app;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text;
BEGIN
  -- missing_ok = true -> NULL instead of erroring when the GUC is unset.
  raw := current_setting('app.current_tenant', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  -- Guard the cast: a non-UUID value yields NULL (deny), never an exception
  -- that could short-circuit policy evaluation.
  BEGIN
    RETURN raw::uuid;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END
$$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO claimflow_app;

-- Helper to apply the standard symmetric tenant policy to an own-tenant_id table.
DO $$
DECLARE
  tbl text;
  own_tenant_tables text[] := ARRAY[
    'facilities','users','claims','preauthorizations',
    'webhook_endpoints','webhook_deliveries',
    'investigation_cases','case_claims',
    'api_keys','oauth_clients',
    'claim_lines','audit_sessions','rule_results','documents','extracted_fields',
    'idempotency_keys'
  ];
BEGIN
  FOREACH tbl IN ARRAY own_tenant_tables LOOP
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
$$;

-- ---------------------------------------------------------------------------
-- audit_trail and case_events: append-only under RLS.
--   SELECT + INSERT policies only (no UPDATE/DELETE policy). Combined with the
--   privilege-level REVOKE in 023, the app role can read and append but never
--   mutate or delete history.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_trail ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_trail FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_trail_select ON audit_trail;
DROP POLICY IF EXISTS audit_trail_insert ON audit_trail;
CREATE POLICY audit_trail_select ON audit_trail FOR SELECT TO claimflow_app
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY audit_trail_insert ON audit_trail FOR INSERT TO claimflow_app
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS case_events_select ON case_events;
DROP POLICY IF EXISTS case_events_insert ON case_events;
CREATE POLICY case_events_select ON case_events FOR SELECT TO claimflow_app
  USING (tenant_id = app.current_tenant_id());
CREATE POLICY case_events_insert ON case_events FOR INSERT TO claimflow_app
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- B2 leaf tables (no own tenant_id): policy via EXISTS join to the parent.
-- WITH CHECK uses the same predicate so a child can't be written under a parent
-- in another tenant.
-- ---------------------------------------------------------------------------

-- document_pages -> documents -> (documents already tenant-scoped)
ALTER TABLE document_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_pages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_pages_tenant_isolation ON document_pages;
CREATE POLICY document_pages_tenant_isolation ON document_pages FOR ALL TO claimflow_app
  USING (EXISTS (SELECT 1 FROM documents d
                 WHERE d.id = document_pages.document_id
                   AND d.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d
                      WHERE d.id = document_pages.document_id
                        AND d.tenant_id = app.current_tenant_id()));

-- ocr_text -> documents
ALTER TABLE ocr_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_text FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ocr_text_tenant_isolation ON ocr_text;
CREATE POLICY ocr_text_tenant_isolation ON ocr_text FOR ALL TO claimflow_app
  USING (EXISTS (SELECT 1 FROM documents d
                 WHERE d.id = ocr_text.document_id
                   AND d.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d
                      WHERE d.id = ocr_text.document_id
                        AND d.tenant_id = app.current_tenant_id()));

-- corrections -> extracted_fields
ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS corrections_tenant_isolation ON corrections;
CREATE POLICY corrections_tenant_isolation ON corrections FOR ALL TO claimflow_app
  USING (EXISTS (SELECT 1 FROM extracted_fields e
                 WHERE e.id = corrections.extracted_field_id
                   AND e.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM extracted_fields e
                      WHERE e.id = corrections.extracted_field_id
                        AND e.tenant_id = app.current_tenant_id()));

-- mfa_devices -> users
ALTER TABLE mfa_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mfa_devices_tenant_isolation ON mfa_devices;
CREATE POLICY mfa_devices_tenant_isolation ON mfa_devices FOR ALL TO claimflow_app
  USING (EXISTS (SELECT 1 FROM users u
                 WHERE u.id = mfa_devices.user_id
                   AND u.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM users u
                      WHERE u.id = mfa_devices.user_id
                        AND u.tenant_id = app.current_tenant_id()));

-- refresh_tokens -> users
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refresh_tokens_tenant_isolation ON refresh_tokens;
CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens FOR ALL TO claimflow_app
  USING (EXISTS (SELECT 1 FROM users u
                 WHERE u.id = refresh_tokens.user_id
                   AND u.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM users u
                      WHERE u.id = refresh_tokens.user_id
                        AND u.tenant_id = app.current_tenant_id()));

-- preauthorization_service_codes -> preauthorizations
ALTER TABLE preauthorization_service_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE preauthorization_service_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS preauth_service_codes_tenant_isolation ON preauthorization_service_codes;
CREATE POLICY preauth_service_codes_tenant_isolation ON preauthorization_service_codes FOR ALL TO claimflow_app
  USING (EXISTS (SELECT 1 FROM preauthorizations p
                 WHERE p.id = preauthorization_service_codes.preauthorization_id
                   AND p.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM preauthorizations p
                      WHERE p.id = preauthorization_service_codes.preauthorization_id
                        AND p.tenant_id = app.current_tenant_id()));

-- ---------------------------------------------------------------------------
-- tenants: a tenant may read its own row; provisioning stays on the owner path.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_self_read ON tenants;
CREATE POLICY tenants_self_read ON tenants FOR SELECT TO claimflow_app
  USING (id = app.current_tenant_id());
GRANT SELECT ON tenants TO claimflow_app;
