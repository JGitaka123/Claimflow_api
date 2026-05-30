-- 014_indexes.sql — Performance indexes for common queries

CREATE INDEX IF NOT EXISTS idx_claims_dashboard ON claims(tenant_id, facility_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rule_results_failures ON rule_results(rule_id, result) WHERE result = 'FAIL';
CREATE INDEX IF NOT EXISTS idx_audit_sessions_date ON audit_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_corrections_pending ON corrections(used_for_training) WHERE used_for_training = false;
