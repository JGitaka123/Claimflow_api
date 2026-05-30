-- 005_extraction.sql

DO $$ BEGIN
    CREATE TYPE field_confidence_tier AS ENUM ('HIGH', 'MEDIUM', 'LOW');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS ocr_text (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    raw_text        TEXT NOT NULL,
    engine          TEXT NOT NULL,
    overall_confidence REAL NOT NULL,
    word_count      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(document_id, page_number, engine)
);

CREATE TABLE IF NOT EXISTS extracted_fields (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    field_key       TEXT NOT NULL,
    field_value     TEXT,
    confidence      REAL NOT NULL,
    confidence_tier field_confidence_tier NOT NULL,
    bbox_json       JSONB,
    source          TEXT NOT NULL DEFAULT 'OCR',
    needs_review    BOOLEAN NOT NULL DEFAULT false,
    reviewed        BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS corrections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    extracted_field_id  UUID NOT NULL REFERENCES extracted_fields(id) ON DELETE CASCADE,
    original_value      TEXT,
    corrected_value     TEXT NOT NULL,
    corrected_by        UUID NOT NULL REFERENCES users(id),
    corrected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_for_training   BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_ocr_text_doc ON ocr_text(document_id);
CREATE INDEX IF NOT EXISTS idx_extracted_fields_claim ON extracted_fields(claim_id);
CREATE INDEX IF NOT EXISTS idx_extracted_fields_review ON extracted_fields(claim_id, needs_review, reviewed);
CREATE INDEX IF NOT EXISTS idx_corrections_field ON corrections(extracted_field_id);
CREATE INDEX IF NOT EXISTS idx_corrections_training ON corrections(used_for_training) WHERE used_for_training = false;
