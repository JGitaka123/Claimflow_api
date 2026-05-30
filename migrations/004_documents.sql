-- 004_documents.sql

DO $$ BEGIN
    CREATE TYPE doc_type AS ENUM (
        'SHA_CLAIM_FORM_OP', 'SHA_CLAIM_FORM_IP', 'SHA_CLAIM_FORM_MATERNITY',
        'PREAUTH_FORM', 'DISCHARGE_SUMMARY', 'PHYSICIAN_NOTES', 'LAB_RESULTS',
        'PRESCRIPTION', 'REFERRAL_LETTER', 'RADIOLOGY_REPORT', 'OPERATIVE_NOTE',
        'NATIONAL_ID_COPY', 'SHA_CARD_COPY', 'CONSENT_FORM', 'OTHER_SUPPORTING'
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE doc_processing_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'MANUAL_ENTRY_REQUIRED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE doc_processing_route AS ENUM ('FULL_OCR_EXTRACT', 'EXISTENCE_QUALITY_ONLY', 'STRUCTURED_EXTRACT', 'SIGNATURE_DETECT_ONLY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    claim_id        UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    doc_type        doc_type NOT NULL,
    processing_route doc_processing_route NOT NULL,
    mime_type       TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    page_count      INTEGER NOT NULL DEFAULT 0,
    file_size_bytes BIGINT NOT NULL,
    storage_path    TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    processing_status doc_processing_status NOT NULL DEFAULT 'PENDING',
    processing_error TEXT,
    uploaded_by     UUID NOT NULL REFERENCES users(id),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_pages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number     INTEGER NOT NULL,
    status          doc_processing_status NOT NULL DEFAULT 'PENDING',
    ocr_engine_used TEXT,
    overall_confidence REAL,
    image_quality_score REAL,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    error_message   TEXT,
    processed_at    TIMESTAMPTZ,
    UNIQUE(document_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_documents_claim ON documents(claim_id);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_document_pages_doc ON document_pages(document_id);
