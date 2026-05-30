from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np
from PIL import Image


def detect_signature_or_stamp(image: Image.Image) -> dict[str, Any]:
    rgb = np.array(image.convert('RGB'))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    height, width = gray.shape
    start_row = int(height * 0.7)
    signature_region = gray[start_row:, :]

    _, thresholded = cv2.threshold(
        signature_region,
        0,
        255,
        cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU,
    )

    ink_pixels = int(np.count_nonzero(thresholded))
    total_pixels = int(thresholded.size) if thresholded.size > 0 else 1
    ink_density = ink_pixels / total_pixels

    contours, _ = cv2.findContours(thresholded, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not contours or ink_density < 0.003:
        return {
            'type': 'SIGNATURE',
            'present': False,
            'confidence': round(max(0.0, min(1.0, ink_density * 50.0)), 4),
            'bbox': None,
        }

    largest = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(largest)
    contour_area = cv2.contourArea(largest)

    aspect_ratio = w / max(float(h), 1.0)
    normalized_area = contour_area / max(float(total_pixels), 1.0)

    if 0.75 <= aspect_ratio <= 1.35 and normalized_area > 0.02:
        detection_type = 'STAMP'
    else:
        detection_type = 'SIGNATURE'

    confidence = (ink_density * 25.0) + min(0.4, normalized_area * 8.0)
    confidence = max(0.0, min(1.0, confidence))

    return {
        'type': detection_type,
        'present': True,
        'confidence': round(confidence, 4),
        'bbox': {
            'x': int(x),
            'y': int(y + start_row),
            'w': int(w),
            'h': int(h),
        },
    }
