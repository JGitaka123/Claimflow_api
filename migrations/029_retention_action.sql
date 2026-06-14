-- 029_retention_action.sql
--
-- Item 9 (compliance scaffolding) — extend the audit_action enum so the
-- retention purge job can write its own immutable record of what it deleted
-- (per-tenant counts per category + cutoff + retention windows). The audit_trail
-- table itself remains absolutely append-only (its trigger from 008 is
-- unchanged); the purge job only deletes from operational tables.

DO $$ BEGIN
    ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'RETENTION_PURGE_RUN';
EXCEPTION WHEN duplicate_object THEN null;
END $$;
