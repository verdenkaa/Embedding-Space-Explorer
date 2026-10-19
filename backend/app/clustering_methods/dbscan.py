"""DBSCAN clustering + run identity.

Labels are int32 with -1 = noise/unassigned — shown honestly as
«шум/не определено», never as a separate "meaning" (spec requirement).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
from collections.abc import Mapping

import numpy as np


class ClusteringParamsError(ValueError):
    """Raised when clustering parameters are invalid (before queueing)."""


def run_dbscan(matrix: np.ndarray, metric: str, eps: float, min_samples: int) -> np.ndarray:
    """DBSCAN labels for an (N, D) float matrix; deterministic by nature."""
    from sklearn.cluster import DBSCAN

    data = np.asarray(matrix, dtype=np.float32)
    if data.ndim != 2 or data.shape[0] == 0:
        raise ClusteringParamsError("clustering needs a non-empty (N, D) matrix")
    if metric not in ("cosine", "euclidean"):
        raise ClusteringParamsError(f"unsupported metric '{metric}'")
    if not np.isfinite(eps) or eps <= 0:
        raise ClusteringParamsError("eps must be a positive number")
    if min_samples < 2:
        raise ClusteringParamsError("min_samples must be at least 2")
    model = DBSCAN(eps=float(eps), min_samples=int(min_samples), metric=metric)
    labels = np.asarray(model.fit_predict(data), dtype=np.int32)
    return labels


def clustering_fingerprint(
    embedding_run_id: str,
    space: str,
    projection_run_id: str | None,
    algorithm: str,
    metric: str,
    params: Mapping[str, object],
) -> str:
    """Stable id of everything that influences the labels."""
    payload = "\n".join(
        [
            f"emb={embedding_run_id}",
            f"space={space}",
            f"proj={projection_run_id or ''}",
            f"algo={algorithm}",
            f"metric={metric}",
            f"params={json.dumps(dict(params), sort_keys=True, default=str)}",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def clustering_versions(algorithm: str) -> dict[str, str]:
    """Library versions that influenced the labels."""
    from importlib import metadata

    versions: dict[str, str] = {"numpy": np.__version__}
    distributions = ["scikit-learn"]
    for dist in distributions:
        with contextlib.suppress(metadata.PackageNotFoundError):
            versions[dist] = metadata.version(dist)
    versions["algorithm"] = algorithm
    return versions
