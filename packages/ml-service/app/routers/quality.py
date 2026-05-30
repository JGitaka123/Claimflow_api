from __future__ import annotations

import math
from statistics import median
from typing import Any

import cv2
import numpy as np
from PIL import Image


A4_WIDTH_INCHES = 8.27
A4_HEIGHT_INCHES = 11.69


def _estimate_skew(gray: np.ndarray) -> float:
    edges = cv2.Canny(gray, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=80,
        minLineLength=max(20, gray.shape[1] // 4),
        maxLineGap=15,
    )

    if lines is None:
        return 0.0

    angles: list[float] = []

    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = math.degrees(math.atan2(y2 - y1, x2 - x1))

        while angle <= -90:
            angle += 180

        while angle > 90:
            angle -= 180

        if abs(angle) <= 30:
            angles.append(angle)

    if not angles:
        return 0.0

    return float(median(angles))


def assess_image_quality(image: Image.Image) -> dict[str, Any]:
    rgb = np.array(image.convert('RGB'))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    blur_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    # Log scaling avoids under-scoring clean pages with sparse text content.
    blur_score = max(
        0.0,
        min(1.0, math.log1p(blur_variance) / math.log1p(500.0)),
    )

    skew_degrees = _estimate_skew(gray)
    skew_score = max(0.0, min(1.0, 1.0 - (abs(skew_degrees) / 15.0)))

    height, width = gray.shape
    dpi_width = width / A4_WIDTH_INCHES
    dpi_height = height / A4_HEIGHT_INCHES
    dpi_estimated = float(min(dpi_width, dpi_height))
    dpi_score = max(0.0, min(1.0, dpi_estimated / 300.0))

    score = (0.5 * blur_score) + (0.25 * skew_score) + (0.25 * dpi_score)

    return {
        'score': round(max(0.0, min(1.0, score)), 4),
        'blur_score': round(blur_score, 4),
        'skew_degrees': round(skew_degrees, 4),
        'dpi_estimated': round(dpi_estimated, 2),
    }


