from __future__ import annotations

import re
from typing import Any


SHA_ID_PATTERN = re.compile(r'(CR\d{9}-\d)', re.IGNORECASE)
PROVIDER_ID_PATTERN = re.compile(r'(FID-\d{2}-\d{6}-\d)', re.IGNORECASE)
DATE_PATTERN = re.compile(r'(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4})')
ICD_PATTERN = re.compile(r'\b([A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?)\b')
AMOUNT_PATTERN = re.compile(r'(?:claim amount|total amount|amount)\s*[:\-]?\s*(?:KES|KSH|KSHS)?\s*([0-9,]+(?:\.[0-9]{2})?)', re.IGNORECASE)


def _find_after_label(text: str, labels: list[str]) -> str | None:
    lowered = text.lower()

    for label in labels:
        marker = label.lower()
        position = lowered.find(marker)

        if position < 0:
            continue

        tail = text[position + len(marker):]
        first_line = tail.strip().splitlines()[0] if tail.strip() else ''
        cleaned = first_line.strip(' :.-\t')

        if cleaned:
            return cleaned[:120]

    return None


def extract_sha_claim_fields(ocr_text: str) -> list[dict[str, Any]]:
    text = ocr_text or ''
    fields: list[dict[str, Any]] = []

    sha_match = SHA_ID_PATTERN.search(text)
    if sha_match:
        fields.append({'field_key': 'patient_sha_id', 'value': sha_match.group(1), 'confidence': 0.95})

    provider_match = PROVIDER_ID_PATTERN.search(text)
    if provider_match:
        fields.append({'field_key': 'provider_id', 'value': provider_match.group(1), 'confidence': 0.92})

    patient_name = _find_after_label(text, ['patient name', 'member name', 'name of patient'])
    if patient_name:
        fields.append({'field_key': 'patient_name', 'value': patient_name, 'confidence': 0.8})

    physician_name = _find_after_label(text, ['physician name', 'doctor name', 'attending physician'])
    if physician_name:
        fields.append({'field_key': 'physician_name', 'value': physician_name, 'confidence': 0.78})

    diagnosis = _find_after_label(text, ['diagnosis', 'primary diagnosis'])
    if diagnosis:
        fields.append({'field_key': 'diagnosis', 'value': diagnosis, 'confidence': 0.76})

    icd_match = ICD_PATTERN.search(text)
    if icd_match:
        fields.append({'field_key': 'icd_code', 'value': icd_match.group(1), 'confidence': 0.72})

    date_matches = DATE_PATTERN.findall(text)
    if date_matches:
        fields.append({'field_key': 'admission_date', 'value': date_matches[0], 'confidence': 0.7})

    if len(date_matches) > 1:
        fields.append({'field_key': 'discharge_date', 'value': date_matches[1], 'confidence': 0.68})

    amount_match = AMOUNT_PATTERN.search(text)
    if amount_match:
        amount_value = amount_match.group(1).replace(',', '')
        fields.append({'field_key': 'claim_amount', 'value': amount_value, 'confidence': 0.74})

    return fields
