"""Automatic clustering methods.

MVP scope: DBSCAN from scikit-learn — one well-tested algorithm instead of a
gallery of half-used ones. The space a clustering runs in is EXPLICIT and
persisted ("original" vectors with a distance metric, or one projection's
coordinates with euclidean) — the UI must show which one produced the
clusters, and clusters are never renamed to "topics" automatically.

Adding a method later = a new runner function + a catalog entry; the job,
cache format (ids + int32 labels .npz) and API stay.
"""

from app.clustering_methods.dbscan import (
    ClusteringParamsError,
    clustering_fingerprint,
    clustering_versions,
    run_dbscan,
)

__all__ = [
    "ClusteringParamsError",
    "clustering_fingerprint",
    "clustering_versions",
    "run_dbscan",
]
