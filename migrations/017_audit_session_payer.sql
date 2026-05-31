-- 017_audit_session_payer.sql
--
-- Slice 2: record the exact payer alongside the rulepack version + checksum on
-- every audit session, so the immutable audit trail captures *which payer's
-- rules* produced a decision. This keeps historical audits reproducible even if a
-- payer's active rulepack_version later changes.

ALTER TABLE audit_sessions ADD COLUMN IF NOT EXISTS payer_id UUID REFERENCES payers(id);
ALTER TABLE audit_sessions ADD COLUMN IF NOT EXISTS payer_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_sessions_payer ON audit_sessions(payer_id);

-- Backfill existing sessions to the SHA payer (the only payer that existed before
-- multi-payer support). Idempotent: only touches rows not yet stamped.
UPDATE audit_sessions a
   SET payer_id = p.id,
       payer_slug = p.slug
  FROM payers p
 WHERE p.slug = 'sha'
   AND a.payer_slug IS NULL;
