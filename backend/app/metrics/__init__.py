"""Geometry-quality metrics (TZ §5.6, §10.1 `metrics`).

Every metric ships with an explicit explanation and the counts it was
computed over — a number without its interpretation is forbidden. The
relation-based metrics encode the corpus-incompleteness rule of TZ §5.6:
an ABSENT known relation is never treated as proof of absence (unknown
pairs are excluded from denominators; the explanations say so).
"""

from app.metrics.compute import (
    METRIC_EXPLANATIONS,
    MetricsInputError,
    compute_metric_bundle,
    relation_pairs_from_rows,
)

__all__ = [
    "METRIC_EXPLANATIONS",
    "MetricsInputError",
    "compute_metric_bundle",
    "relation_pairs_from_rows",
]
