"""Reference validation, snapshots and summaries for saved experiments."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import SCHEMA_VERSION, __version__
from app.storage.models import (
    ClusteringRunRow,
    EmbeddingRunRow,
    FileRow,
    FragmentGroupRow,
    FragmentRow,
    MetricRunRow,
    ProjectionRunRow,
    SavedSliceRow,
)
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache

#: Hard cap on the stored selection (an experiment is a config, not a dump).
SELECTION_CAP = 5000


def iter_references(config: dict[str, Any]) -> Iterator[tuple[str, str]]:
    """Yield (field, id) for every referenced entity of an experiment config.

    `field` names the config path (used in missing/stale reports), id is the
    referenced row id. The selection is validated separately (bulk).
    """
    emb = config.get("embedding_run_id")
    if emb:
        yield "embedding_run_id", str(emb)
    projections = config.get("projections") or {}
    if projections.get("three"):
        yield "projections.three", str(projections["three"])
    if projections.get("four"):
        yield "projections.four", str(projections["four"])
    for pid in projections.get("two") or []:
        yield "projections.two", str(pid)
    slice_cfg = config.get("slice") or {}
    if slice_cfg.get("saved_slice_id"):
        yield "slice.saved_slice_id", str(slice_cfg["saved_slice_id"])
    if slice_cfg.get("embedding_run_id"):
        yield "slice.embedding_run_id", str(slice_cfg["embedding_run_id"])
    if config.get("clustering_run_id"):
        yield "clustering_run_id", str(config["clustering_run_id"])
    for gid in config.get("group_ids") or []:
        yield "group_ids", str(gid)
    for mid in config.get("metric_run_ids") or []:
        yield "metric_run_ids", str(mid)


def _exists(session: Session, field: str, ref_id: str) -> bool:
    model = {
        "embedding_run_id": EmbeddingRunRow,
        "slice.embedding_run_id": EmbeddingRunRow,
        "projections.three": ProjectionRunRow,
        "projections.two": ProjectionRunRow,
        "projections.four": ProjectionRunRow,
        "slice.saved_slice_id": SavedSliceRow,
        "clustering_run_id": ClusteringRunRow,
        "group_ids": FragmentGroupRow,
        "metric_run_ids": MetricRunRow,
    }[field]
    return session.get(model, ref_id) is not None


def validate_references(
    ctx: ProjectContext, config: dict[str, Any]
) -> tuple[dict[str, list[str]], list[str]]:
    """Check every reference; returns (missing_by_field, valid_selection).

    Selection entries that no longer exist are DROPPED (not an error — a
    reindex may legitimately remove fragments; the snapshot records how many
    were kept).
    """
    missing: dict[str, list[str]] = {}
    with ctx.session_factory() as session:
        for field, ref_id in iter_references(config):
            if not _exists(session, field, ref_id):
                missing.setdefault(field, []).append(ref_id)
        selection = [str(s) for s in (config.get("selection") or [])][:SELECTION_CAP]
        valid_selection: list[str] = []
        if selection:
            existing: set[str] = set()
            for start in range(0, len(selection), 400):
                chunk = selection[start : start + 400]
                rows = session.execute(
                    select(FragmentRow.id).where(FragmentRow.id.in_(chunk))
                ).scalars()
                existing.update(rows)
            valid_selection = [s for s in selection if s in existing]
    return missing, valid_selection


def build_snapshot(ctx: ProjectContext, config: dict[str, Any]) -> dict[str, Any]:
    """Interpretation context AT SAVE TIME (TZ §9.2: versions, corpus, states)."""
    snapshot: dict[str, Any] = {
        "saved_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "app_version": __version__,
        "schema_version": SCHEMA_VERSION,
    }
    with ctx.session_factory() as session:
        files = session.execute(
            select(func.count(FileRow.id)).where(FileRow.status == "indexed")
        ).scalar_one()
        fragments = session.execute(select(func.count(FragmentRow.id))).scalar_one()
        projection_count = session.execute(select(func.count(ProjectionRunRow.id))).scalar_one()
        snapshot["corpus"] = {
            "files_indexed": int(files),
            "fragments": int(fragments),
            "projection_runs": int(projection_count),
        }

        emb_id = config.get("embedding_run_id")
        signature = None
        if emb_id:
            emb = session.get(EmbeddingRunRow, str(emb_id))
            if emb is not None:
                cache = NpzEmbeddingCache.load(ctx.project_dir / emb.npz_relpath)
                if len(cache) > 0:
                    signature = cache.signature()
                snapshot["corpus"]["embedding_vectors"] = int(emb.count)
        snapshot["embedding_signature"] = signature

        # staleness of the referenced computed artifacts at save time
        stale: dict[str, list[str]] = {}
        projections = config.get("projections") or {}
        proj_ids = [
            str(p)
            for p in (
                projections.get("three"),
                projections.get("four"),
                *(projections.get("two") or []),
            )
            if p
        ]
        for pid in proj_ids:
            proj_row = session.get(ProjectionRunRow, pid)
            if proj_row is not None and proj_row.source_signature != signature:
                stale.setdefault("projections", []).append(pid)
        cl_id = config.get("clustering_run_id")
        if cl_id:
            cl_row = session.get(ClusteringRunRow, str(cl_id))
            if cl_row is not None and cl_row.source_signature != signature:
                stale.setdefault("clustering", []).append(str(cl_id))

        # metric values captured for later comparison WITHOUT recomputation
        metric_summary: dict[str, Any] = {}
        for mid in config.get("metric_run_ids") or []:
            metric_row = session.get(MetricRunRow, str(mid))
            if metric_row is None:
                continue
            try:
                result = json.loads(metric_row.result_json)
            except json.JSONDecodeError:  # pragma: no cover - defensive
                continue
            values: dict[str, float | None] = {}
            for name, data in (result.get("metrics") or {}).items():
                if isinstance(data, dict):
                    raw = data.get("value")
                    values[name] = float(raw) if isinstance(raw, (int, float)) else None
            metric_summary[str(mid)] = {
                "k": metric_row.k,
                "sample": metric_row.sample_size,
                "projection_run_id": metric_row.projection_run_id,
                "values": values,
            }
        snapshot["refs_stale_at_save"] = stale
        snapshot["metric_summary"] = metric_summary
    return snapshot


def build_summary(config: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    """Compact human-facing summary for the experiment list."""
    projections = config.get("projections") or {}
    two = projections.get("two") or []
    metric_values: dict[str, float | None] = {}
    for entry in (snapshot.get("metric_summary") or {}).values():
        if isinstance(entry, dict):
            for name, value in (entry.get("values") or {}).items():
                metric_values[name] = value
    return {
        "view_mode": config.get("view_mode"),
        "embedding_run_id": config.get("embedding_run_id"),
        "projections": {
            "three": projections.get("three"),
            "four": projections.get("four"),
            "two_count": len(two),
        },
        "slice": bool(config.get("slice")),
        "clustering_run_id": config.get("clustering_run_id"),
        "groups": len(config.get("group_ids") or []),
        "selection": len(config.get("selection") or []),
        "metric_runs": len(config.get("metric_run_ids") or []),
        "metric_values": metric_values,
    }


def build_live_status(ctx: ProjectContext, config: dict[str, Any]) -> dict[str, Any]:
    """What is missing/stale RIGHT NOW (reported when the experiment opens)."""
    missing: dict[str, list[str]] = {}
    stale: dict[str, list[str]] = {}
    with ctx.session_factory() as session:
        for field, ref_id in iter_references(config):
            if not _exists(session, field, ref_id):
                missing.setdefault(field, []).append(ref_id)
        emb_id = config.get("embedding_run_id")
        signature = None
        if emb_id and session.get(EmbeddingRunRow, str(emb_id)) is not None:
            emb = session.get(EmbeddingRunRow, str(emb_id))
            assert emb is not None
            cache = NpzEmbeddingCache.load(ctx.project_dir / emb.npz_relpath)
            if len(cache) > 0:
                signature = cache.signature()
        projections = config.get("projections") or {}
        proj_fields = [
            ("projections.three", projections.get("three")),
            ("projections.four", projections.get("four")),
            *[("projections.two", p) for p in (projections.get("two") or [])],
        ]
        for field, pid in proj_fields:
            if not pid:
                continue
            proj_row = session.get(ProjectionRunRow, str(pid))
            if (
                proj_row is not None
                and signature is not None
                and proj_row.source_signature != signature
            ):
                stale.setdefault(field, []).append(str(pid))
        cl_id = config.get("clustering_run_id")
        if cl_id:
            cl_row = session.get(ClusteringRunRow, str(cl_id))
            if (
                cl_row is not None
                and signature is not None
                and cl_row.source_signature != signature
            ):
                stale.setdefault("clustering_run_id", []).append(str(cl_id))
    return {"missing": missing, "stale": stale}
