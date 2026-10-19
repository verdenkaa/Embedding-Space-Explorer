"""Semantic neighbor search over the ORIGINAL embeddings.

Never over projection coordinates: the search runs on stored vectors with an
explicit metric (cosine by default, consistent with L2-normalized runs).
"""

from app.neighbor_search.search import METRICS, NeighborHit, knn

__all__ = ["METRICS", "NeighborHit", "knn"]
