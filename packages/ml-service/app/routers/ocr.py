from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pytesseract
from PIL import Image

try:
    from paddleocr import PaddleOCR
except Exception:  # pragma: no cover - optional heavy dependency
    PaddleOCR = None  # type: ignore


@dataclass
class OcrEnginesStatus:
    tesseract_ready: bool
    paddle_available: bool


_paddle_instance: Any | None = None


def _load_paddle() -> Any | None:
    global _paddle_instance

    if PaddleOCR is None:
        return None

    if _paddle_instance is None:
        _paddle_instance = PaddleOCR(use_angle_cls=True, lang='en', show_log=False)

    return _paddle_instance


def init_ocr_engines() -> OcrEnginesStatus:
    paddle_available = PaddleOCR is not None

    try:
        _ = pytesseract.get_tesseract_version()
        tesseract_ready = True
    except Exception:
        tesseract_ready = False

    return OcrEnginesStatus(
        tesseract_ready=tesseract_ready,
        paddle_available=paddle_available,
    )


def run_tesseract_ocr(image: Image.Image) -> tuple[str, float]:
    try:
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
        words: list[str] = []
        confidences: list[float] = []

        for index, raw_word in enumerate(data.get('text', [])):
            if not isinstance(raw_word, str):
                continue

            word = raw_word.strip()
            if not word:
                continue

            raw_conf = data.get('conf', [])[index] if index < len(data.get('conf', [])) else '-1'

            try:
                conf = float(raw_conf)
            except (TypeError, ValueError):
                conf = -1.0

            if conf >= 0:
                words.append(word)
                confidences.append(conf / 100.0)

        if not words:
            text = pytesseract.image_to_string(image)
            clean = text.strip()
            return clean, 0.0 if not clean else 0.55

        confidence = sum(confidences) / len(confidences) if confidences else 0.0
        return ' '.join(words), max(0.0, min(1.0, confidence))
    except Exception:
        return '', 0.0


def run_paddle_ocr(image: Image.Image) -> tuple[str, float] | None:
    paddle = _load_paddle()
    if paddle is None:
        return None

    try:
        image_array = np.array(image.convert('RGB'))
        raw = paddle.ocr(image_array, cls=True)

        words: list[str] = []
        confs: list[float] = []

        for page in raw or []:
            for item in page or []:
                text_info = item[1] if len(item) > 1 else None
                if not text_info or len(text_info) < 2:
                    continue

                text = str(text_info[0]).strip()
                if not text:
                    continue

                try:
                    confidence = float(text_info[1])
                except (TypeError, ValueError):
                    confidence = 0.0

                words.append(text)
                confs.append(max(0.0, min(1.0, confidence)))

        if not words:
            return '', 0.0

        avg_conf = sum(confs) / len(confs) if confs else 0.0
        return ' '.join(words), max(0.0, min(1.0, avg_conf))
    except Exception:
        return None


def _merge_text(primary: str, secondary: str) -> str:
    if not primary:
        return secondary

    if not secondary:
        return primary

    if primary == secondary:
        return primary

    return f"{primary}\n{secondary}"


def process_page_ocr(image: Image.Image, license_tier: str = 'FREE') -> dict[str, Any]:
    tesseract_text, tesseract_conf = run_tesseract_ocr(image)

    final_text = tesseract_text
    final_conf = tesseract_conf
    engine_used = 'tesseract'

    if license_tier.strip().upper() == 'PRO':
        paddle_result = run_paddle_ocr(image)

        if paddle_result is not None:
            paddle_text, paddle_conf = paddle_result
            final_text = _merge_text(tesseract_text, paddle_text)

            if tesseract_conf > 0 and paddle_conf > 0:
                final_conf = (tesseract_conf + paddle_conf) / 2.0
            else:
                final_conf = max(tesseract_conf, paddle_conf)

            engine_used = 'ensemble'

    word_count = len([word for word in final_text.split() if word.strip()])

    return {
        'raw_text': final_text,
        'overall_confidence': round(max(0.0, min(1.0, final_conf)), 4),
        'word_count': word_count,
        'engine': engine_used,
    }
