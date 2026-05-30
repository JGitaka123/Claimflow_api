from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image


SUPPORTED_IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.tif', '.tiff'}


def load_document_pages(storage_path: str, pages: list[int] | None = None) -> list[tuple[int, Image.Image]]:
    path = Path(storage_path)

    if not path.exists():
        raise FileNotFoundError(f'Document not found: {storage_path}')

    suffix = path.suffix.lower()

    if suffix in SUPPORTED_IMAGE_SUFFIXES:
        image = Image.open(path).convert('RGB')
        return [(1, image)]

    if suffix == '.pdf':
        return _load_pdf_pages(path, pages)

    raise ValueError(f'Unsupported document extension: {suffix}')


def _load_pdf_pages(path: Path, pages: list[int] | None = None) -> list[tuple[int, Image.Image]]:
    try:
        import pypdfium2 as pdfium
    except Exception as exc:  # pragma: no cover - dependency optional at runtime
        raise RuntimeError('PDF rendering requires pypdfium2 to be installed') from exc

    document = pdfium.PdfDocument(str(path))

    try:
        total_pages = len(document)

        if total_pages == 0:
            return []

        requested_pages = pages if pages else list(range(1, total_pages + 1))
        loaded_pages: list[tuple[int, Image.Image]] = []

        for page_number in requested_pages:
            if page_number < 1 or page_number > total_pages:
                continue

            page = document[page_number - 1]
            try:
                bitmap = page.render(scale=2.0)
                pil_image = bitmap.to_pil().convert('RGB')
            finally:
                page.close()

            loaded_pages.append((page_number, pil_image))

        return loaded_pages
    finally:
        document.close()
