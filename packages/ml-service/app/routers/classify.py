from __future__ import annotations

from typing import Any


KEYWORD_RULES: dict[str, tuple[str, ...]] = {
    'DISCHARGE_SUMMARY': ('discharge', 'summary', 'final diagnosis'),
    'PRESCRIPTION': ('prescription', 'rx', 'dose', 'pharmacy'),
    'LAB_RESULTS': ('lab result', 'laboratory', 'hematology', 'biochemistry'),
    'PHYSICIAN_NOTES': ('physician notes', 'clinical notes', 'progress notes'),
    'SHA_CLAIM_FORM_MATERNITY': ('maternity', 'antenatal', 'delivery'),
    'SHA_CLAIM_FORM_IP': ('inpatient', 'ward', 'admission'),
    'SHA_CLAIM_FORM_OP': ('claim', 'outpatient', 'sha form'),
}


def classify_document(filename: str, ocr_text: str) -> dict[str, Any]:
    text_blob = f"{filename} {ocr_text}".lower()
    score_map: dict[str, int] = {}

    for doc_type, keywords in KEYWORD_RULES.items():
        score = 0

        for keyword in keywords:
            if keyword in text_blob:
                score += 1

        if filename and doc_type.replace('_', ' ').lower() in filename.lower():
            score += 2

        score_map[doc_type] = score

    best_type = max(score_map, key=score_map.get)
    best_score = score_map[best_type]

    if best_score <= 0:
        best_type = 'OTHER_SUPPORTING'
        confidence = 0.35
    else:
        confidence = min(0.99, 0.45 + (best_score * 0.12))

    sorted_alternatives = sorted(
        score_map.items(),
        key=lambda item: item[1],
        reverse=True,
    )

    alternatives = [
        {
            'class': item[0],
            'confidence': round(min(0.95, 0.3 + item[1] * 0.1), 4),
        }
        for item in sorted_alternatives
        if item[0] != best_type and item[1] > 0
    ][:3]

    return {
        'predicted_class': best_type,
        'confidence': round(confidence, 4),
        'alternatives': alternatives,
    }
