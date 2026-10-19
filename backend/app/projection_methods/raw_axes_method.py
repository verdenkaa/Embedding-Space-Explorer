"""Raw-axes projection: display selected dimensions of the ORIGINAL space.

The user picks 2–4 axis indices (0..D-1) of the embedding vectors and sees
their exact coordinates — the only "projection" that distorts nothing inside
the chosen subspace (4 axes feed the 4D view: first three are the scene,
the fourth is the "time" slider). Honesty requirements:
- axes are model dimensions; the app never claims human-interpretable
  semantics for an individual axis (the UI says so);
- distances on such a map ignore all non-selected dimensions — they are NOT
  full-space distances (caveat is stored with the method and shown in UI).

This is the primary exploration mode for finding interesting axis
combinations; found combinations are saved as named presets (db v4) so the
researcher can return to them later (reproducible by construction: the
projection cache fingerprint includes the axis list).
"""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np

from app.projection_methods.base import (
    ParamSpec,
    ProjectionMethod,
    ProjectionParamsError,
    ProjectionResult,
)


def _axes_of(params: Mapping[str, object]) -> list[int]:
    raw = params.get("axes", [])
    if not isinstance(raw, (list, tuple)):  # pragma: no cover - validated earlier
        raise ProjectionParamsError("parameter 'axes' must be a list of integers")
    return [int(a) for a in raw]


class RawAxesMethod(ProjectionMethod):
    method_id = "raw_axes"
    display_name = "Сырые оси"
    description = (
        "Координаты выбранных осей ИСХОДНОГО embedding-пространства (2–4 измерения "
        "из D) без преобразований: внутри выбранного подпространства ничего не "
        "искажается. Оси — измерения модели и не имеют «человеческой» семантики."
    )
    caveat = (
        "Расстояния на такой карте учитывают только выбранные оси и НЕ равны "
        "расстояниям исходного D-мерного пространства: отброшенные измерения "
        "игнорируются."
    )
    param_specs = (
        ParamSpec(
            name="axes",
            type="int_list",
            default=[],
            description=(
                "Индексы осей исходного пространства (0-индексация), по одной на "
                "компоненту отображения: 2 оси → 2D-карта, 3 оси → 3D-сцена, "
                "4 оси → 4D-вид (первые три — сцена, четвёртая — слайдер «времени»)."
            ),
            min_items=2,
            max_items=4,
        ),
        ParamSpec(
            name="standardize",
            type="bool",
            default=False,
            description=(
                "Стандартизировать каждую выбранную ось (z-score): уравнивает "
                "масштабы осей с разной дисперсией. Исходные значения при этом "
                "не меняются — только отображаемые координаты."
            ),
        ),
    )

    def is_available(self) -> bool:
        return True  # pure numpy — always available

    def fit(
        self,
        vectors: np.ndarray,
        *,
        n_components: int,
        params: Mapping[str, object],
        seed: int,
    ) -> ProjectionResult:
        del seed  # axis selection is deterministic by definition
        data = np.asarray(vectors, dtype=np.float32)
        if data.ndim != 2:
            raise ProjectionParamsError("vectors must be a 2-D array")
        n_samples, dim = data.shape
        if n_samples < 1:
            raise ProjectionParamsError("no vectors to project")

        axes = _axes_of(params)
        if len(axes) != n_components:
            raise ProjectionParamsError(
                f"axes count ({len(axes)}) must equal n_components ({n_components})"
            )
        out_of_range = [a for a in axes if a < 0 or a >= dim]
        if out_of_range:
            raise ProjectionParamsError(f"axis indices out of range 0..{dim - 1}: {out_of_range}")

        coords = data[:, axes].astype(np.float32, copy=True)
        # axis_info: per-axis standard deviation of the ORIGINAL values —
        # the scale each displayed axis carries (interpretation aid).
        stds = tuple(float(s) for s in np.std(data[:, axes], axis=0))

        if bool(params.get("standardize", False)):
            mean = coords.mean(axis=0)
            std = coords.std(axis=0)
            std[std == 0] = 1.0  # degenerate axis: center only, honest 0 spread
            coords = ((coords - mean) / std).astype(np.float32)

        labels = tuple(f"dim {a}" for a in axes)
        return ProjectionResult(coords=coords, axis_labels=labels, axis_info=stds)
