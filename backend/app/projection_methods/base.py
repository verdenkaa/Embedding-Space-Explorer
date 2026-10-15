"""Projection methods: interface, parameter specs, fingerprints (TZ §5.2).

A projection maps stored D-dimensional embedding vectors to 2D/3D display
coordinates. It never modifies the original vectors; method, parameters,
seed and library versions are persisted with every projection run so the
result stays observable and reproducible (TZ §9.2).

Key distinction kept by the whole app (TZ §5): a projection is NOT a slice
of the original space. Axes of a projection belong to the projection; the
UI must say which method produced the visible coordinates.

Adding a new method = a `ProjectionMethod` subclass + a catalog entry in
`registry.py`; nothing else in the app changes (TZ §10.1).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

import numpy as np

ParamType = Literal["int", "float", "bool", "choice"]

#: Display components a projection can be computed for (2D map / 3D scene).
SUPPORTED_COMPONENTS: tuple[int, ...] = (2, 3)


class ProjectionParamsError(ValueError):
    """Raised when user-provided projection parameters are invalid."""


class ProjectionMethodUnavailableError(RuntimeError):
    """Raised when the method's runtime cannot be imported/initialized.

    Carries an actionable message (TZ §12): typically a dependency that was
    not installed or not enough free RAM for the numba import.
    """


class UnknownProjectionMethodError(KeyError):
    """Raised when a method_id is not in the catalog."""


@dataclass(frozen=True)
class ParamSpec:
    """Declarative description of one tunable parameter.

    Drives both server-side validation and the UI form (single source of
    truth — no hidden values, TZ §12).
    """

    name: str
    type: ParamType
    default: bool | int | float | str
    description: str
    min_value: float | None = None
    max_value: float | None = None
    step: float | None = None
    choices: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ProjectionResult:
    """Coordinates plus everything needed to interpret them honestly."""

    #: (N, n_components) float32 display coordinates
    coords: np.ndarray
    #: axis captions, e.g. ("PC1", "PC2") / ("UMAP1", "UMAP2")
    axis_labels: tuple[str, ...]
    #: per-axis interpretability info (PCA: explained variance ratio);
    #: None when the method has no such quantity (UMAP)
    axis_info: tuple[float, ...] | None = None


class ProjectionMethod:
    """Interface every projection method implements."""

    #: stable identifier persisted in projection runs
    method_id: str = ""
    display_name: str = ""
    description: str = ""
    #: honesty note for the UI: how the map may mislead (TZ §5.2, §19)
    caveat: str = ""
    param_specs: tuple[ParamSpec, ...] = ()

    def is_available(self) -> bool:
        """Cheap availability probe (no heavy import side effects)."""
        raise NotImplementedError

    def validate_params(self, raw: Mapping[str, object]) -> dict[str, object]:
        """Normalize and validate user parameters against `param_specs`.

        Missing keys take declared defaults; UNKNOWN keys are rejected (an
        implicit ignore would hide a typo that changes interpretation).
        Returns the normalized dict that is persisted and fingerprinted.
        """
        normalized: dict[str, object] = {}
        specs = {spec.name: spec for spec in self.param_specs}
        for key in raw:
            if key not in specs:
                raise ProjectionParamsError(
                    f"unknown parameter '{key}' for method '{self.method_id}'; "
                    f"supported: {', '.join(specs) or 'none'}"
                )
        for name, spec in specs.items():
            value = raw.get(name, spec.default)
            normalized[name] = _coerce_param(spec, value)
        return normalized

    def fit(
        self,
        vectors: np.ndarray,
        *,
        n_components: int,
        params: Mapping[str, object],
        seed: int,
    ) -> ProjectionResult:
        """Compute display coordinates for ALL given vectors.

        Implementations must be deterministic for a fixed (input, params,
        seed) — reproducibility is a core requirement (TZ §9.2).
        """
        raise NotImplementedError


def _coerce_param(spec: ParamSpec, value: object) -> bool | int | float | str:
    if spec.type == "bool":
        if not isinstance(value, bool):
            raise ProjectionParamsError(f"parameter '{spec.name}' must be a boolean")
        return value
    if spec.type == "choice":
        if not isinstance(value, str) or (spec.choices and value not in spec.choices):
            allowed = ", ".join(spec.choices or ())
            raise ProjectionParamsError(f"parameter '{spec.name}' must be one of: {allowed}")
        return value
    if spec.type in ("int", "float"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ProjectionParamsError(f"parameter '{spec.name}' must be a number")
        if spec.type == "int":
            if isinstance(value, float) and not float(value).is_integer():
                raise ProjectionParamsError(f"parameter '{spec.name}' must be an integer")
            value = int(value)
        else:
            value = float(value)
        if spec.min_value is not None and value < spec.min_value:
            raise ProjectionParamsError(f"parameter '{spec.name}' must be >= {spec.min_value:g}")
        if spec.max_value is not None and value > spec.max_value:
            raise ProjectionParamsError(f"parameter '{spec.name}' must be <= {spec.max_value:g}")
        return value
    raise ProjectionParamsError(f"parameter '{spec.name}' has unsupported type")  # pragma: no cover


def projection_fingerprint(
    embedding_run_id: str,
    method: str,
    n_components: int,
    params: Mapping[str, object],
    seed: int,
) -> str:
    """Stable id of everything that influences the resulting coordinates.

    Same configuration over the same embedding run = same fingerprint =
    same cache file (recompute is idempotent, TZ §9.3).
    """
    payload = "\n".join(
        [
            f"emb={embedding_run_id}",
            f"method={method}",
            f"n_components={n_components}",
            f"params={json.dumps(params, sort_keys=True, default=str)}",
            f"seed={seed}",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def normalize_components(raw: list[int]) -> list[int]:
    """Validate/dedupe requested display components ([3, 2] by default)."""
    if not raw:
        return [3, 2]
    seen: list[int] = []
    for value in raw:
        if value not in SUPPORTED_COMPONENTS:
            raise ProjectionParamsError(
                f"n_components must be one of {SUPPORTED_COMPONENTS}, got {value}"
            )
        if value not in seen:
            seen.append(value)
    return seen


def sanitize_axis_label(label: str) -> str:
    """Axis labels are persisted; keep them short and JSON-safe."""
    return re.sub(r"\s+", " ", label)[:32]


__all__ = [
    "SUPPORTED_COMPONENTS",
    "ParamSpec",
    "ProjectionMethod",
    "ProjectionMethodUnavailableError",
    "ProjectionParamsError",
    "ProjectionResult",
    "UnknownProjectionMethodError",
    "normalize_components",
    "projection_fingerprint",
]
