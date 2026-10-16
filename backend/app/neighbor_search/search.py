"""k-nearest-neighbor search with explicit metrics (TZ §5.6, §7.1).

Brute-force numpy over the run's vectors: exact by construction and fast
enough for a local research corpus (N×D dot products); no approximate index
is smuggled in — the result the UI shows IS the exact ranking.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

METRICS: tuple[str, ...] = ("cosine", "euclidean")


class NeighborSearchError(ValueError):
    """Raised when the search inputs are unusable."""


@dataclass(frozen=True)
class NeighborHit:
    index: int
    #: metric-dependent distance (smaller = closer)
    distance: float
    #: metric-dependent similarity (larger = closer):
    #: cosine → cosine similarity in [-1, 1]; euclidean → -distance
    score: float


def knn(
    vectors: np.ndarray,
    query_index: int,
    k: int,
    metric: str,
) -> list[NeighborHit]:
    """Exact k nearest neighbors of `vectors[query_index]`, self excluded."""
    data = np.asarray(vectors, dtype=np.float32)
    if data.ndim != 2 or data.shape[0] == 0:
        raise NeighborSearchError("no vectors to search")
    if not 0 <= query_index < data.shape[0]:
        raise NeighborSearchError("query index out of range")
    if k < 1:
        raise NeighborSearchError("k must be >= 1")
    if metric not in METRICS:
        raise NeighborSearchError(f"unknown metric '{metric}'; supported: {', '.join(METRICS)}")

    query = data[query_index]
    if metric == "cosine":
        norms = np.linalg.norm(data, axis=1)
        q_norm = float(np.linalg.norm(query))
        if q_norm == 0:
            raise NeighborSearchError("query vector has zero norm (cosine undefined)")
        # zero-norm rows get similarity 0 instead of nan (honest: directionless)
        safe = np.where(norms == 0, 1.0, norms)
        sims = (data @ query) / (safe * q_norm)
        sims = np.where(norms == 0, 0.0, sims)
        distances = 1.0 - sims
        scores = sims
    else:  # euclidean
        diff = data - query
        distances = np.sqrt(np.einsum("ij,ij->i", diff, diff))
        scores = -distances

    order = np.argsort(distances, kind="stable")
    hits: list[NeighborHit] = []
    for idx in order:
        i = int(idx)
        if i == query_index:
            continue
        hits.append(NeighborHit(index=i, distance=float(distances[i]), score=float(scores[i])))
        if len(hits) >= k:
            break
    return hits
