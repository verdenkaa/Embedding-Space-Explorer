"""Experiment manager: capture, validate and interpret
saved experiments.

An experiment is a named, reopenable snapshot of the research state: which
embedding run, which projections the views showed, the slice definition,
clustering, groups, selection and metric runs — PLUS the interpretation
context recorded at save time (corpus counts, embedding signature, app and
schema versions, staleness of every reference, metric values). Reopening
reports missing/stale references honestly instead of silently substituting
something else.
"""

from app.experiment_manager.manager import (
    SELECTION_CAP,
    build_live_status,
    build_snapshot,
    build_summary,
    iter_references,
)

__all__ = [
    "SELECTION_CAP",
    "build_live_status",
    "build_snapshot",
    "build_summary",
    "iter_references",
]
