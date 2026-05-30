from PIL import Image, ImageDraw

from app.routers.quality import assess_image_quality


def test_quality_check_on_clear_image_returns_high_score() -> None:
    image = Image.new('RGB', (2480, 3508), 'white')
    draw = ImageDraw.Draw(image)
    draw.text((200, 300), 'CLAIMFLOW QUALITY TEST', fill='black')
    draw.text((200, 380), 'KENYA SHA CLAIM FORM', fill='black')

    result = assess_image_quality(image)

    assert result['score'] >= 0.6
    assert result['blur_score'] >= 0.5
    assert result['dpi_estimated'] > 200
