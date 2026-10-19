"""Model catalog and provider factory.

Adding a new model = a new `ModelInfo` entry here (for sentence-transformers
runtimes). A different runtime = a new EmbeddingProvider subclass + a branch
in `create_provider`. Nothing else changes.
"""

from __future__ import annotations

from pathlib import Path

from app.embedding_providers.base import EmbeddingProvider, ModelInfo
from app.embedding_providers.sentence_transformers_provider import SentenceTransformerProvider

MODEL_CATALOG: tuple[ModelInfo, ...] = (
    ModelInfo(
        model_id="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        display_name="paraphrase-multilingual-MiniLM-L12-v2",
        dim=384,
        approx_download_mb=470,
        description=(
            "Мультиязычная (включая русский) универсальная текстовая модель, 384 измерения. "
            "НЕ специализирована на исходном коде — качество на коде является рабочей "
            "гипотезой. Стартовая модель по умолчанию."
        ),
        is_default=True,
    ),
    ModelInfo(
        model_id="sentence-transformers/all-MiniLM-L6-v2",
        display_name="all-MiniLM-L6-v2",
        dim=384,
        approx_download_mb=90,
        description=(
            "Компактная англоязычная модель, 384 измерения. Заметно легче на машинах "
            "с 8 ГБ RAM; русский текст кодирует хуже мультиязычной."
        ),
        is_default=False,
    ),
)


def get_model_info(model_id: str) -> ModelInfo | None:
    for info in MODEL_CATALOG:
        if info.model_id == model_id:
            return info
    return None


def default_model_info() -> ModelInfo:
    for info in MODEL_CATALOG:
        if info.is_default:
            return info
    return MODEL_CATALOG[0]  # pragma: no cover - catalog always has a default


class UnknownModelError(KeyError):
    pass


def create_provider(model_id: str, data_dir: Path) -> EmbeddingProvider:
    """Factory for providers. Currently one runtime: sentence-transformers."""
    info = get_model_info(model_id)
    if info is None:
        raise UnknownModelError(model_id)
    return SentenceTransformerProvider(info, data_dir / "models")
