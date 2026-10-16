"""Semantic neighbor search over the ORIGINAL embeddings (TZ §7.1).

Never over projection coordinates: the search runs on stored vectors with an
explicit metric (cosine by default, consistent with L2-normalized runs).
"""

from app.neighbor_search.search import METRICS, NeighborHit, knn

__all__ = ["METRICS", "NeighborHit", "knn"]
