"""Projection methods package.

Public surface used by jobs/api:
- `registry`: METHODS catalog (PCA / UMAP / raw axes), get_method/require_method,
  library_versions;
- `base`: ProjectionMethod interface, ParamSpec, fingerprint, errors;
- `cache`: ProjectionCache (.npz coordinate store).
"""

from __future__ import annotations

from app.projection_methods.base import (
    SUPPORTED_COMPONENTS,
    ParamSpec,
    ProjectionMethod,
    ProjectionMethodUnavailableError,
    ProjectionParamsError,
    ProjectionResult,
    UnknownProjectionMethodError,
    normalize_components,
    projection_fingerprint,
)
from app.projection_methods.cache import ProjectionCache
from app.projection_methods.registry import (
    METHODS,
    get_method,
    library_versions,
    require_method,
)

__all__ = [
    "METHODS",
    "SUPPORTED_COMPONENTS",
    "ParamSpec",
    "ProjectionCache",
    "ProjectionMethod",
    "ProjectionMethodUnavailableError",
    "ProjectionParamsError",
    "ProjectionResult",
    "UnknownProjectionMethodError",
    "get_method",
    "library_versions",
    "normalize_components",
    "projection_fingerprint",
    "require_method",
]
