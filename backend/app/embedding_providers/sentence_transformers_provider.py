"""sentence-transformers provider (CPU, local cache, batched encode).

All heavy imports are lazy so the application starts and reports honest
diagnostics even before stage-2 dependencies are installed.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

import numpy as np

from app.embedding_providers.base import (
    EmbeddingCancelledError,
    EmbeddingProvider,
    ModelInfo,
    ModelNotDownloadedError,
    ProviderLoadError,
)


class SentenceTransformerProvider(EmbeddingProvider):
    """Provider backed by a local sentence-transformers model on CPU."""

    def __init__(self, info: ModelInfo, models_dir: Path) -> None:
        self._info = info
        self._models_dir = models_dir
        self._model: Any = None

    # -- catalog / status ---------------------------------------------------

    def info(self) -> ModelInfo:
        return self._info

    def _hub_dir_name(self) -> str:
        # huggingface hub cache layout: models--<org>--<name>
        return "models--" + self._info.model_id.replace("/", "--")

    def is_downloaded(self) -> bool:
        """Cheap presence check of the hub cache dir (no model loading)."""
        name = self._hub_dir_name()
        for candidate in (self._models_dir / name, self._models_dir / "hub" / name):
            if candidate.is_dir():
                # A snapshot with weights must exist, not just refs/locks.
                snapshots = candidate / "snapshots"
                if snapshots.is_dir() and any(snapshots.iterdir()):
                    return True
        return False

    # -- loading / download ---------------------------------------------------

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from sentence_transformers import SentenceTransformer  # lazy: heavy
        except ImportError as exc:  # pragma: no cover - guarded by health/deps
            raise ProviderLoadError(
                "sentence-transformers is not installed; run scripts/dev.bat to install "
                "stage-2 dependencies"
            ) from exc
        except (MemoryError, RuntimeError, OSError) as exc:
            # A failed torch import leaves partially-initialized modules behind;
            # surface an actionable message instead of pybind cascades (TZ §12).
            raise ProviderLoadError(
                f"failed to initialize torch/sentence-transformers ({exc.__class__.__name__}). "
                "Likely not enough free RAM: close memory-hungry applications and restart "
                "the backend window"
            ) from exc
        self._models_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._model = SentenceTransformer(
                self._info.model_id,
                cache_folder=str(self._models_dir),
                device="cpu",
            )
        except OSError as exc:
            raise ModelNotDownloadedError(
                f"model '{self._info.model_id}' is not in the local cache: {exc.__class__.__name__}"
            ) from exc
        return self._model

    def download(self, progress_message: Callable[[str], None] | None = None) -> None:
        if progress_message:
            progress_message(
                f"downloading '{self._info.model_id}' (~{self._info.approx_download_mb} MB) "
                f"into {self._models_dir}"
            )
        # Loading with network access performs the download into cache_folder.
        self._model = None
        self._load()
        if progress_message:
            progress_message("model weights cached; subsequent runs work offline")

    # -- inference -------------------------------------------------------------

    def encode(
        self,
        texts: Sequence[str],
        *,
        batch_size: int = 16,
        normalize: bool = True,
        progress_cb: Callable[[int, int], None] | None = None,
        cancel_check: Callable[[], None] | None = None,
    ) -> np.ndarray:
        model = self._load()
        total = len(texts)
        if total == 0:
            dim = int(model.get_embedding_dimension())
            return np.zeros((0, dim), dtype=np.float32)

        chunks: list[np.ndarray] = []
        done = 0
        for start in range(0, total, batch_size):
            if cancel_check is not None:
                cancel_check()  # raises EmbeddingCancelledError
            batch = list(texts[start : start + batch_size])
            vectors = model.encode(
                batch,
                batch_size=len(batch),
                convert_to_numpy=True,
                normalize_embeddings=normalize,
                show_progress_bar=False,
            )
            chunks.append(np.asarray(vectors, dtype=np.float32))
            done += len(batch)
            if progress_cb is not None:
                progress_cb(done, total)
        result = np.vstack(chunks)
        if cancel_check is not None:
            cancel_check()
        return result


def set_hf_offline_flags(offline: bool) -> None:
    """Force huggingface_hub offline mode after the first download (TZ §1.1)."""
    os.environ["HF_HUB_OFFLINE"] = "1" if offline else "0"
    os.environ["TRANSFORMERS_OFFLINE"] = "1" if offline else "0"


__all__ = [
    "EmbeddingCancelledError",
    "ProviderLoadError",
    "SentenceTransformerProvider",
    "set_hf_offline_flags",
]
