"""Projection method catalog (single extension point).

Adding a new projection method:
1. implement `ProjectionMethod` (see pca_method.py / umap_method.py);
2. append an instance to `METHODS` below.
Cache keys (fingerprints) include the method id, so different methods never
mix coordinates; the API catalog endpoint exposes parameter specs to the UI
form — no other module needs changes.
"""

from __future__ import annotations

from app.projection_methods.base import ProjectionMethod, UnknownProjectionMethodError
from app.projection_methods.pca_method import PcaMethod
from app.projection_methods.raw_axes_method import RawAxesMethod
from app.projection_methods.umap_method import UmapMethod

METHODS: tuple[ProjectionMethod, ...] = (PcaMethod(), UmapMethod(), RawAxesMethod())


def get_method(method_id: str) -> ProjectionMethod | None:
    for method in METHODS:
        if method.method_id == method_id:
            return method
    return None


def require_method(method_id: str) -> ProjectionMethod:
    method = get_method(method_id)
    if method is None:
        raise UnknownProjectionMethodError(method_id)
    return method


def library_versions(method_id: str) -> dict[str, str]:
    """Versions of everything that influenced the coordinates.

    Recorded in the projection run row; library updates do NOT invalidate
    caches (same policy as embedding runs) but are visible for
    interpretation of saved results.
    """
    import contextlib
    from importlib import metadata

    import numpy as np

    versions: dict[str, str] = {"numpy": np.__version__}
    distributions = ["scikit-learn"]
    if method_id == "umap":
        distributions.append("umap-learn")
    for dist in distributions:
        # required dependencies; a missing dist stays invisible in versions
        with contextlib.suppress(metadata.PackageNotFoundError):
            versions[dist] = metadata.version(dist)
    return versions


__all__ = [
    "METHODS",
    "UnknownProjectionMethodError",
    "get_method",
    "library_versions",
    "require_method",
]
