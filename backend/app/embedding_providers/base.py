"""Embedding providers: model interface and implementations (TZ §2.3).

The provider interface is the single extension point for models: a new model
is a catalog entry (+ optionally a new provider class for a different runtime).
All heavy imports (torch, sentence_transformers) are lazy — the app must start
and report honest diagnostics without them installed.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ModelInfo:
    """Static description of an embedding model in the catalog."""

    model_id: str
    display_name: str
    dim: int
    approx_download_mb: int
    description: str
    is_default: bool = False


class ModelNotDownloadedError(RuntimeError):
    """Raised when encoding is requested before the weights are cached."""


class ProviderLoadError(RuntimeError):
    """Raised when the ML runtime cannot be imported/initialized.

    Carries an actionable message (TZ §12): typically missing dependencies
    or not enough free RAM for the torch import.
    """


class EmbeddingCancelledError(RuntimeError):
    """Raised by providers when the cancel check trips between batches."""


class EmbeddingProvider:
    """Interface every model provider implements."""

    def info(self) -> ModelInfo:
        raise NotImplementedError

    def is_downloaded(self) -> bool:
        raise NotImplementedError

    def download(self, progress_message: Callable[[str], None] | None = None) -> None:
        """Blocking download of model weights into the local cache."""
        raise NotImplementedError

    def encode(
        self,
        texts: Sequence[str],
        *,
        batch_size: int = 16,
        normalize: bool = True,
        progress_cb: Callable[[int, int], None] | None = None,
        cancel_check: Callable[[], None] | None = None,
    ) -> np.ndarray:
        """Encode texts to float32 [N, dim]; cancel_check may raise.

        Implementations process in batches of `batch_size` (RAM budget on
        8 GB machines, TZ §2.3) and call progress_cb(done, total) after each
        batch. `cancel_check` is invoked between batches and must raise
        EmbeddingCancelledError when cancellation was requested.
        """
        raise NotImplementedError


def params_fingerprint(model_id: str, mode: str, template: str, params: dict[str, object]) -> str:
    """Stable fingerprint of everything that influences resulting vectors."""
    payload = "\n".join(
        [
            f"model={model_id}",
            f"mode={mode}",
            f"template_sha={hashlib.sha256(template.encode('utf-8')).hexdigest()[:16]}",
            f"params={sorted(params.items())}",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
