"""UMAP projection (TZ §5.2: the additional non-linear method).

umap-learn is imported lazily: its numba runtime costs several seconds and
hundreds of MB of RAM on first import — the app must stay responsive and
diagnosable without paying that until UMAP is actually requested.

Determinism: with `random_state=seed` UMAP is reproducible (verified by
tests); the price is single-threaded layout optimization (umap itself warns
about n_jobs=1 — expected and suppressed, reproducibility wins, TZ §9.2).
"""

from __future__ import annotations

import importlib.util
import warnings
from collections.abc import Mapping

import numpy as np

from app.projection_methods.base import (
    ParamSpec,
    ProjectionMethod,
    ProjectionMethodUnavailableError,
    ProjectionParamsError,
    ProjectionResult,
)


def _param_number(params: Mapping[str, object], key: str, default: float) -> float:
    """Numeric parameter access for mypy: validate_params already coerced the
    stored values, but the mapping type stays `object` at the interface."""
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


class UmapMethod(ProjectionMethod):
    method_id = "umap"
    display_name = "UMAP"
    description = (
        "Нелинейная проекция, сохраняющая локальную структуру соседств. "
        "Полезна, чтобы увидеть кластеры, которые PCA сжимает в одну массу."
    )
    caveat = (
        "UMAP-карта визуально убедительна, но искажает расстояния: близость "
        "кластеров и длины осей НЕ трактуются как исходные расстояния без "
        "оговорок. С фиксированным seed результат воспроизводим."
    )
    param_specs = (
        ParamSpec(
            name="n_neighbors",
            type="int",
            default=15,
            description=(
                "Размер локального окрестности: малые значения подчеркивают "
                "мелкую структуру, большие — глобальную."
            ),
            min_value=2,
            max_value=500,
            step=1,
        ),
        ParamSpec(
            name="min_dist",
            type="float",
            default=0.1,
            description="Минимальное расстояние между точками в проекции (плотность карты).",
            min_value=0.0,
            max_value=0.99,
            step=0.01,
        ),
        ParamSpec(
            name="metric",
            type="choice",
            default="cosine",
            description=(
                "Метрика в исходном пространстве. Cosine согласован с "
                "L2-нормализованными векторами запусков эмбеддингов."
            ),
            choices=("cosine", "euclidean"),
        ),
    )

    def is_available(self) -> bool:
        return importlib.util.find_spec("umap") is not None

    def _import_umap(self) -> object:
        try:
            with warnings.catch_warnings():
                # numba emits deprecation/pedantic warnings on import; they are
                # noise for the user and must not fail the job.
                warnings.simplefilter("ignore")
                import umap  # lazy: heavy numba runtime
        except ImportError as exc:
            raise ProjectionMethodUnavailableError(
                "umap-learn is not installed; run scripts/dev.bat (Windows) or "
                "./scripts/dev.sh to install backend dependencies"
            ) from exc
        except (MemoryError, RuntimeError, OSError) as exc:
            raise ProjectionMethodUnavailableError(
                f"failed to initialize umap/numba ({exc.__class__.__name__}). "
                "Likely not enough free RAM: close memory-hungry applications "
                "and restart the backend"
            ) from exc
        return umap

    def fit(
        self,
        vectors: np.ndarray,
        *,
        n_components: int,
        params: Mapping[str, object],
        seed: int,
    ) -> ProjectionResult:
        umap = self._import_umap()

        data = np.asarray(vectors, dtype=np.float32)
        if data.ndim != 2:
            raise ProjectionParamsError("vectors must be a 2-D array")
        n_samples = data.shape[0]
        if n_samples < 3:
            raise ProjectionParamsError(
                f"UMAP needs at least 3 vectors, got {n_samples}; "
                "compute embeddings for more fragments first"
            )
        n_neighbors = int(_param_number(params, "n_neighbors", 15.0))
        if n_neighbors >= n_samples:
            raise ProjectionParamsError(
                f"n_neighbors ({n_neighbors}) must be smaller than the number of "
                f"points ({n_samples}); reduce n_neighbors or embed more fragments"
            )

        reducer = umap.UMAP(  # type: ignore[attr-defined]
            n_components=n_components,
            n_neighbors=n_neighbors,
            min_dist=_param_number(params, "min_dist", 0.1),
            metric=str(params.get("metric", "cosine")),
            random_state=seed,
            low_memory=True,
        )
        with warnings.catch_warnings():
            # "n_jobs value 1 overridden to 1 by setting random_state" —
            # intentional: seeded (reproducible) layout is single-threaded.
            warnings.filterwarnings(
                "ignore", message=r".*n_jobs value 1 overridden.*", category=UserWarning
            )
            coords = np.asarray(reducer.fit_transform(data), dtype=np.float32)

        labels = tuple(f"UMAP{i + 1}" for i in range(n_components))
        return ProjectionResult(coords=coords, axis_labels=labels, axis_info=None)
