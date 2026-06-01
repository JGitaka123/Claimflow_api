-- 023_rls_roles_and_columns.sql
--
-- Item 6c, part 1 of 2: the application role + the schema changes that the RLS
-- policies (migration 024) depend on. This migration is additive and safe to
-- run before 024. It runs on the privileged/owner path (scripts/migrate.sh).
--
--   1. Create the non-superuser, non-BYPASSRLS `claimflow_app` role and grant it
--      least-privilege DML on tenant tables + SELECT-only on the global tables.
--   2. Add tenant_id to the high-traffic child tables (the "B1" set) and to
--      idempotency_keys, backfill from the parent, and add a COMPOSITE FK that
--      includes tenant_id so a child row's tenant_id can never diverge from its
--      parent's.
--   3. Add tenant-leading composite indexes for RLS predicate performance.

-- ---------------------------------------------------------------------------
-- 1. Application role (idempotent; password is set out-of-band by ops)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claimflow_app') THEN
    -- NOLOGIN by default: ops sets a password / LOGIN when wiring APP_DATABASE_URL.
    -- Explicitly NOSUPERUSER NOBYPASSRLS so the role can never skip RLS.
    CREATE ROLE claimflow_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
  END IF;
END
$$;

-- The app role must see the schema and use sequences, but never run DDL.
GRANT USAGE ON SCHEMA public TO claimflow_app;

-- Tenant-scoped tables: full DML (RLS confines each statement to one tenant).
-- audit_trail / case_events get INSERT+SELECT only (append-only — see 024).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  facilities, users, claims, preauthorizations,
  webhook_endpoints, webhook_deliveries,
  investigation_cases, case_claims, case_events,
  api_keys, oauth_clients,
  claim_lines, audit_sessions, rule_results, documents, document_pages,
  ocr_text, extracted_fields, corrections, mfa_devices, refresh_tokens,
  preauthorization_service_codes, idempotency_keys
TO claimflow_app;

-- audit_trail and case_events are append-only for the app role: INSERT + SELECT
-- only. The absence of UPDATE/DELETE grants is enforced at the privilege level
-- (belt) and reinforced by the lack of an UPDATE/DELETE policy in 024 (braces).
GRANT SELECT, INSERT ON audit_trail TO claimflow_app;
REVOKE UPDATE, DELETE ON audit_trail FROM claimflow_app;
-- case_events: SELECT/INSERT already granted above; remove mutation rights.
REVOKE UPDATE, DELETE ON case_events FROM claimflow_app;

-- Global reference / catalog tables: SELECT-only, deliberately (not blanket).
-- These are shared across tenants and must remain readable under RLS. They have
-- no tenant_id and carry no RLS policy, so the app role reads them freely but
-- can never mutate reference data.
GRANT SELECT ON
  payers, icd_codes, sha_service_codes, registry_cache,
  tariffs, tariff_versions, rulepacks, rulepack_rules
TO claimflow_app;

-- Sequences the app role writes through (UUID PKs use gen_random_uuid(), but
-- any serial/identity sequences need USAGE). Safe no-op when there are none.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO claimflow_app;

-- NOTE: outbox_events, sync_events, license_state, schema_migrations are
-- intentionally NOT granted to claimflow_app — they are owner/worker-only
-- (access-path audit in docs/rls-design.md confirmed none are read or written
-- on the synchronous app-role request path).

-- ---------------------------------------------------------------------------
-- 2. Denormalized tenant_id on the B1 child tables + idempotency_keys
--    (parents first get UNIQUE(id, tenant_id) so children can FK to it)
-- ---------------------------------------------------------------------------

-- Idempotent constraint helper: ADD CONSTRAINT has no IF NOT EXISTS, and the
-- test harness replays every migration, so guard each add by name.
-- Parent claims must expose (id, tenant_id) as a unique key for the composite
-- FKs. (claims.tenant_id already exists; safe to add the key up front.)
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_claims_id_tenant') THEN
    ALTER TABLE claims ADD CONSTRAINT uq_claims_id_tenant UNIQUE (id, tenant_id);
  END IF;
END
$mig$;

-- claim_lines -> claims
ALTER TABLE claim_lines     ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE claim_lines cl SET tenant_id = c.tenant_id
  FROM claims c WHERE c.id = cl.claim_id AND cl.tenant_id IS NULL;
ALTER TABLE claim_lines     ALTER COLUMN tenant_id SET NOT NULL;

-- audit_sessions -> claims (add the column BEFORE its unique key)
ALTER TABLE audit_sessions  ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE audit_sessions a SET tenant_id = c.tenant_id
  FROM claims c WHERE c.id = a.claim_id AND a.tenant_id IS NULL;
ALTER TABLE audit_sessions  ALTER COLUMN tenant_id SET NOT NULL;
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_audit_sessions_id_tenant') THEN
    ALTER TABLE audit_sessions ADD CONSTRAINT uq_audit_sessions_id_tenant UNIQUE (id, tenant_id);
  END IF;
END
$mig$;

-- rule_results -> audit_sessions
ALTER TABLE rule_results    ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE rule_results r SET tenant_id = a.tenant_id
  FROM audit_sessions a WHERE a.id = r.audit_session_id AND r.tenant_id IS NULL;
ALTER TABLE rule_results    ALTER COLUMN tenant_id SET NOT NULL;

-- documents -> claims
ALTER TABLE documents       ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE documents d SET tenant_id = c.tenant_id
  FROM claims c WHERE c.id = d.claim_id AND d.tenant_id IS NULL;
ALTER TABLE documents       ALTER COLUMN tenant_id SET NOT NULL;

-- extracted_fields -> claims
ALTER TABLE extracted_fields ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE extracted_fields e SET tenant_id = c.tenant_id
  FROM claims c WHERE c.id = e.claim_id AND e.tenant_id IS NULL;
ALTER TABLE extracted_fields ALTER COLUMN tenant_id SET NOT NULL;

-- idempotency_keys: add tenant_id so a replayed key can never return another
-- tenant's cached response body. Existing rows (if any) are transient (24h TTL);
-- they predate tenant scoping, so clear them rather than guess an owner. The PK
-- becomes composite (tenant_id, idempotency_key) so two tenants can use the same
-- client-chosen key without colliding.
DELETE FROM idempotency_keys;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS tenant_id UUID NOT NULL;
DO $mig$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_pkey') THEN
    ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idempotency_keys_tenant_key_pkey') THEN
    ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_tenant_key_pkey
      PRIMARY KEY (tenant_id, idempotency_key);
  END IF;
END
$mig$;

-- Composite FKs (guarded — ADD CONSTRAINT has no IF NOT EXISTS). These enforce
-- that a child row's tenant_id can never diverge from its parent's.
DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_claim_lines_claim_tenant') THEN
    ALTER TABLE claim_lines ADD CONSTRAINT fk_claim_lines_claim_tenant
      FOREIGN KEY (claim_id, tenant_id) REFERENCES claims(id, tenant_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_audit_sessions_claim_tenant') THEN
    ALTER TABLE audit_sessions ADD CONSTRAINT fk_audit_sessions_claim_tenant
      FOREIGN KEY (claim_id, tenant_id) REFERENCES claims(id, tenant_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_rule_results_session_tenant') THEN
    ALTER TABLE rule_results ADD CONSTRAINT fk_rule_results_session_tenant
      FOREIGN KEY (audit_session_id, tenant_id) REFERENCES audit_sessions(id, tenant_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_documents_claim_tenant') THEN
    ALTER TABLE documents ADD CONSTRAINT fk_documents_claim_tenant
      FOREIGN KEY (claim_id, tenant_id) REFERENCES claims(id, tenant_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_extracted_fields_claim_tenant') THEN
    ALTER TABLE extracted_fields ADD CONSTRAINT fk_extracted_fields_claim_tenant
      FOREIGN KEY (claim_id, tenant_id) REFERENCES claims(id, tenant_id) ON DELETE CASCADE;
  END IF;
END
$mig$;

-- ---------------------------------------------------------------------------
-- 3. Tenant-leading composite indexes for RLS predicate performance.
--    Every policy adds `tenant_id = current_tenant`; a tenant-leading index
--    keeps scans selective.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_claim_lines_tenant        ON claim_lines(tenant_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_audit_sessions_tenant     ON audit_sessions(tenant_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_rule_results_tenant       ON rule_results(tenant_id, audit_session_id);
CREATE INDEX IF NOT EXISTS idx_documents_tenant          ON documents(tenant_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_extracted_fields_tenant   ON extracted_fields(tenant_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_tenant   ON idempotency_keys(tenant_id);

-- Leaf tables policed via EXISTS join to their parent (the "B2" set): index the
-- join column so the policy sub-select stays cheap.
CREATE INDEX IF NOT EXISTS idx_document_pages_doc_join    ON document_pages(document_id);
CREATE INDEX IF NOT EXISTS idx_ocr_text_doc_join          ON ocr_text(document_id);
CREATE INDEX IF NOT EXISTS idx_corrections_field_join     ON corrections(extracted_field_id);
CREATE INDEX IF NOT EXISTS idx_mfa_devices_user_join      ON mfa_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_join   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_preauth_service_codes_join ON preauthorization_service_codes(preauthorization_id);
