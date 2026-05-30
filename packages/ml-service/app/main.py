"""ClaimFlow ML Service - OCR, document classification, signature detection"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .engines import extract_sha_claim_fields, load_document_pages
from .routers import (
    assess_image_quality,
    classify_document,
    detect_signature_or_stamp,
    init_ocr_engines,
    process_page_ocr,
)


class ProcessDocumentRequest(BaseModel):
    document_id: str = Field(min_length=1)
    storage_path: str = Field(min_length=1)
    doc_type: str = Field(min_length=1)
    processing_route: Literal[
        'FULL_OCR_EXTRACT',
        'EXISTENCE_QUALITY_ONLY',
        'STRUCTURED_EXTRACT',
        'SIGNATURE_DETECT_ONLY',
    ]
    pages: list[int] | None = None
    filename: str | None = None
    license_tier: Literal['FREE', 'PRO'] = 'FREE'


class PageProcessResult(BaseModel):
    page_number: int
    status: Literal['COMPLETED', 'FAILED']
    quality: dict[str, Any] | None = None
    ocr: dict[str, Any] | None = None
    classification: dict[str, Any] | None = None
    extracted_fields: list[dict[str, Any]] | None = None
    signature: dict[str, Any] | None = None
    error: str | None = None


class ProcessDocumentResponse(BaseModel):
    document_id: str
    doc_type: str
    processing_route: str
    status: Literal['COMPLETED', 'PARTIAL']
    processed_at: str
    total_pages: int
    pages_processed: int
    pages_failed: int
    pages: list[PageProcessResult]
    aggregated_fields: list[dict[str, Any]]


app = FastAPI(
    title='ClaimFlow ML Service',
    version='1.0.0',
    description='OCR, document classification, signature detection and quality checks for SHA claims documents',
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.on_event('startup')
def _startup() -> None:
    app.state.ocr_engines = init_ocr_engines()
    app.state.doc_classifier_loaded = True


@app.get('/health')
def health() -> dict[str, Any]:
    engines = getattr(app.state, 'ocr_engines', None)

    return {
        'status': 'ok',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'ocr_engines': {
            'tesseract_ready': bool(getattr(engines, 'tesseract_ready', False)),
            'paddle_available': bool(getattr(engines, 'paddle_available', False)),
        },
        'doc_classifier_loaded': bool(getattr(app.state, 'doc_classifier_loaded', False)),
    }


@app.post('/ml/process-document', response_model=ProcessDocumentResponse)
def process_document(request: ProcessDocumentRequest) -> ProcessDocumentResponse:
    try:
        pages = load_document_pages(request.storage_path, request.pages)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - unexpected loader failures
        raise HTTPException(status_code=400, detail=f'Unable to load document: {exc}') from exc

    if not pages:
        raise HTTPException(status_code=422, detail='No pages found to process')

    page_results: list[PageProcessResult] = []
    aggregated_fields: list[dict[str, Any]] = []
    failed_pages = 0

    for page_number, image in pages:
        try:
            quality = assess_image_quality(image)
            result = PageProcessResult(page_number=page_number, status='COMPLETED', quality=quality)

            if request.processing_route in {'FULL_OCR_EXTRACT', 'STRUCTURED_EXTRACT'}:
                ocr_result = process_page_ocr(image=image, license_tier=request.license_tier)
                result.ocr = ocr_result

                classifier_input = request.filename or request.storage_path
                result.classification = classify_document(classifier_input, ocr_result['raw_text'])

                extracted = extract_sha_claim_fields(ocr_result['raw_text'])
                enriched = [
                    {
                        **field,
                        'page_number': page_number,
                    }
                    for field in extracted
                ]
                result.extracted_fields = enriched
                aggregated_fields.extend(enriched)

            if request.processing_route in {'FULL_OCR_EXTRACT', 'SIGNATURE_DETECT_ONLY'}:
                result.signature = detect_signature_or_stamp(image)

            page_results.append(result)
        except Exception as exc:
            failed_pages += 1
            page_results.append(
                PageProcessResult(
                    page_number=page_number,
                    status='FAILED',
                    error=str(exc),
                )
            )

    status: Literal['COMPLETED', 'PARTIAL'] = 'COMPLETED' if failed_pages == 0 else 'PARTIAL'

    return ProcessDocumentResponse(
        document_id=request.document_id,
        doc_type=request.doc_type,
        processing_route=request.processing_route,
        status=status,
        processed_at=datetime.now(timezone.utc).isoformat(),
        total_pages=len(pages),
        pages_processed=len(pages) - failed_pages,
        pages_failed=failed_pages,
        pages=page_results,
        aggregated_fields=aggregated_fields,
    )
