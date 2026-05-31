-- 018_claim_payer_not_null.sql
--
-- Slice-2 follow-up: every claim must carry a payer. Safe migration path:
--   1. Backfill existing claims with a NULL payer_id to the SHA payer (the only
--      payer that existed before multi-payer support).
--   2. Only then apply the NOT NULL constraint, so no row violates it.
-- The API always sets payer_id on claim creation (defaulting to SHA), so new
-- inserts already satisfy the constraint. Reversible via DROP NOT NULL.

UPDATE claims c
   SET payer_id = p.id
  FROM payers p
 WHERE p.slug = 'sha'
   AND c.payer_id IS NULL;

ALTER TABLE claims ALTER COLUMN payer_id SET NOT NULL;
