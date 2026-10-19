"""Mathematics of a slice (layer) in the original embedding space.

A slice is a SELECTION of points in a slab around a hyperplane defined in
the original D-dimensional space — never a crop of a rendered picture and
never a clipping plane. For a plane point `p` and unit normal `n`:

    d(x) = dot(x - p, n)        signed distance to the plane
    x in layer  <=>  |d(x)| <= t / 2

`p` is parameterized as `centroid + position * n` (centroid of the run's
vectors), so `position` is a coordinate along the normal in the vectors' own
units and the slider range comes from the data itself.

MVP normal specifications:
- "axis":   a basis vector e_i of the ORIGINAL space (an embedding dimension);
- "pca":    the i-th principal direction of the run's vectors (deterministic
            full-SVD PCA with svd_flip — reproducible normal);
- "vector": an explicit D-dimensional vector (normalized here); this is what
            saved slices persist, so a saved slice stays reproducible even if
            the data (and a refitted PCA) changes later.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


class SliceParamsError(ValueError):
    """Raised when a slice definition cannot be resolved against the data."""


def resolve_normal(
    kind: str,
    index: int | None,
    vector: list[float] | None,
    vectors: np.ndarray,
) -> np.ndarray:
    """Build the unit normal for a slice specification.

    `vectors` is the (N, D) float array of the embedding run — needed for
    PCA directions and dimension checks.
    """
    data = np.asarray(vectors, dtype=np.float64)
    if data.ndim != 2 or data.shape[0] == 0:
        raise SliceParamsError("slice needs a non-empty set of vectors")
    dim = data.shape[1]

    if kind == "vector":
        if vector is None:
            raise SliceParamsError("normal kind 'vector' requires the vector")
        if len(vector) != dim:
            raise SliceParamsError(f"normal vector has {len(vector)} entries, expected {dim}")
        n = np.array(vector, dtype=np.float64)
        norm = float(np.linalg.norm(n))
        if norm <= 0:
            raise SliceParamsError("normal vector must not be zero")
        return n / norm

    if index is None or index < 0:
        raise SliceParamsError(f"normal kind '{kind}' requires a non-negative index")

    if kind == "axis":
        if index >= dim:
            raise SliceParamsError(f"axis index {index} out of range 0..{dim - 1}")
        n = np.zeros(dim, dtype=np.float64)
        n[index] = 1.0
        return n

    if kind == "pca":
        limit = min(data.shape[0], dim)
        if index >= limit:
            raise SliceParamsError(
                f"PCA direction index {index} out of range 0..{limit - 1} (min(vectors, dim))"
            )
        from sklearn.decomposition import PCA

        # Deterministic: full SVD + svd_flip (same policy as the PCA projection).
        pca = PCA(n_components=index + 1, svd_solver="full")
        pca.fit(data)
        n = np.asarray(pca.components_[index], dtype=np.float64)
        norm = float(np.linalg.norm(n))
        if norm <= 0:  # pragma: no cover - degenerate data still yields unit rows
            raise SliceParamsError("degenerate PCA direction")
        return n / norm

    raise SliceParamsError(f"unknown normal kind '{kind}' (expected axis | pca | vector)")


@dataclass(frozen=True)
class SliceResult:
    """Resolved slice over a run's vectors."""

    #: (D,) unit normal actually used (persisted with saved slices)
    normal: np.ndarray
    #: (D,) centroid the position is measured from
    centroid: np.ndarray
    #: (N,) signed coordinate along the normal: u(x) = dot(x - centroid, n)
    u: np.ndarray
    #: (N,) bool: |u - position| <= thickness / 2
    in_layer: np.ndarray
    position: float
    thickness: float

    @property
    def in_layer_count(self) -> int:
        return int(self.in_layer.sum())


def compute_slice(
    vectors: np.ndarray,
    normal: np.ndarray,
    position: float,
    thickness: float,
) -> SliceResult:
    """Select the layer around plane p = centroid + position·n.

    Pure math over float64 for stable geometry; boundaries are inclusive
    (|d| <= t/2) exactly as the spec defines.
    """
    data = np.asarray(vectors, dtype=np.float64)
    if data.ndim != 2 or data.shape[0] == 0:
        raise SliceParamsError("slice needs a non-empty set of vectors")
    n = np.asarray(normal, dtype=np.float64)
    if n.shape != (data.shape[1],):
        raise SliceParamsError("normal dimension does not match the vectors")
    norm = float(np.linalg.norm(n))
    if norm <= 0:
        raise SliceParamsError("normal vector must not be zero")
    n = n / norm
    if thickness < 0:
        raise SliceParamsError("thickness must not be negative")

    centroid = data.mean(axis=0)
    u = (data - centroid) @ n
    half = float(thickness) / 2.0
    in_layer = np.abs(u - float(position)) <= half
    return SliceResult(
        normal=n,
        centroid=centroid,
        u=u,
        in_layer=in_layer,
        position=float(position),
        thickness=float(thickness),
    )
