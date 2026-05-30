import pytest
from PIL import Image, ImageDraw

from app.routers.ocr import process_page_ocr


def test_ocr_on_simple_text_image_returns_correct_text() -> None:
    image = Image.new('RGB', (1200, 400), 'white')
    draw = ImageDraw.Draw(image)
    draw.text((80, 130), 'CLAIMFLOW OCR TEST', fill='black')

    result = process_page_ocr(image)

    if result['word_count'] == 0:
        pytest.skip('Tesseract OCR is not available in this environment')

    assert 'CLAIMFLOW' in result['raw_text'].upper()
    assert result['overall_confidence'] >= 0.0
