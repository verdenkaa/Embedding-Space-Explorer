"""PCA projection (TZ §5.2: the baseline reproducible linear method).

scikit-learn PCA with svd_solver="full": deterministic (LAPACK SVD, sign
flips resolved by svd_flip), so no seed is needed for reproducibility —
the same vectors always give the same map. Explained variance ratio per
axis is persisted so the UI can show how much structure each axis carries.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Mapping

import numpy as np

from app.projection_methods.base import (
    ParamSpec,
    ProjectionMethod,
    ProjectionParamsError,
    ProjectionResult,
)


class PcaMethod(ProjectionMethod):
    method_id = "pca"
    display_name = "PCA"
    description = (
        "Метод главных компонент — линейная воспроизводимая проекция. "
        "Оси: главные компоненты исходного пространства (PC1 — направление "
        "наибольшей дисперсии)."
    )
    caveat = (
        "Оси принадлежат проекции и не имеют «человеческой» семантики; "
        "расстояния на карте — приближение исходных: доля сохранённой дисперсии "
        "показана для каждой оси."
    )
    param_specs = (
        ParamSpec(
            name="whiten",
            type="bool",
            default=False,
            description=(
                "Отбелить компоненты (масштабировать к единичной дисперсии). "
                "Меняет геометрию карты: формы кластеров искажаются, зато "
                "слабые направления становятся видимыми."
            ),
        ),
    )

    def is_available(self) -> bool:
        # scikit-learn is a required dependency; find_spec is a cheap honest
        # probe without paying its ~1 s import at catalog time.
        return importlib.util.find_spec("sklearn") is not None

    def fit(
        self,
        vectors: np.ndarray,
        *,
        n_components: int,
        params: Mapping[str, object],
        seed: int,
    ) -> ProjectionResult:
        del seed  # PCA(full SVD) is deterministic; seed does not influence it
        from sklearn.decomposition import PCA

        data = np.asarray(vectors, dtype=np.float32)
        if data.ndim != 2:
            raise ProjectionParamsError("vectors must be a 2-D array")
        n_samples, n_features = data.shape
        if n_samples < 2:
            raise ProjectionParamsError(
                f"PCA needs at least 2 vectors, got {n_samples}; "
                "compute embeddings for more fragments first"
            )
        limit = min(n_samples, n_features)
        if n_components > limit:
            raise ProjectionParamsError(
                f"n_components={n_components} exceeds min(vectors={n_samples}, "
                f"dim={n_features})={limit}"
            )

        pca = PCA(
            n_components=n_components,
            whiten=bool(params.get("whiten", False)),
            svd_solver="full",
        )
        with np.errstate(divide="ignore", invalid="ignore"):
            # Degenerate input (identical vectors) → zero total variance:
            # sklearn divides by it; we report honest zeros instead of NaN.
            coords = np.asarray(pca.fit_transform(data), dtype=np.float32)
        ratios = tuple(0.0 if np.isnan(r) else float(r) for r in pca.explained_variance_ratio_)
        labels = tuple(f"PC{i + 1}" for i in range(n_components))
        return ProjectionResult(coords=coords, axis_labels=labels, axis_info=ratios)
