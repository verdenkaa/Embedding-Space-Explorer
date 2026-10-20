"""Clustering jobs: DBSCAN labels over an EXPLICIT space.

Design notes:
- the space is part of the run identity: "original" (embedding vectors with
  cosine/euclidean distance) or "projection" (coordinates of one projection
  run, euclidean); the UI shows which one produced the labels;
- labels never overwrite manual groups (separate entities) and
  never touch the vectors;
- the run stores the embedding cache signature at compute time; a mismatch
  marks the clustering stale instead of silently showing outdated labels;
- identity = fingerprint(emb, space, projection, algo, metric, params): the
  same configuration re-run is idempotent (row + .npz updated in place).
"""

from __future__ import annotations

import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from app.clustering_methods.dbscan import (
    clustering_fingerprint,
    clustering_versions,
    run_dbscan,
)
from app.jobs.manager import JobContext, JobRunner
from app.projection_methods.cache import ProjectionCache
from app.storage.models import ClusteringRunRow, EmbeddingRunRow, ProjectionRunRow
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _param_number(params: dict[str, object], key: str, default: float) -> float:
    """Numeric parameter access for mypy (validated at POST time)."""
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


def make_clustering_runner(
    embedding_run_id: str,
    space: str,
    projection_run_id: str | None,
    algorithm: str,
    metric: str,
    params: dict[str, object],
) -> JobRunner:
    def runner(ctx: JobContext) -> str:
        project = ctx.project
        with project.session_factory() as session:
            emb_run = session.get(EmbeddingRunRow, embedding_run_id)
            if emb_run is None:
                raise ValueError(
                    f"embedding run '{embedding_run_id}' not found; "
                    "compute embeddings first (EXPERIMENTS section)"
                )
            emb_npz = emb_run.npz_relpath

        ctx.progress(0, 3, "loading vectors", force=True)
        emb_cache = NpzEmbeddingCache.load(project.project_dir / emb_npz)
        if len(emb_cache) == 0:
            raise ValueError("the embedding run has no vectors; compute embeddings first")
        signature = emb_cache.signature()

        projection_signature: str | None = None
        if space == "projection":
            assert projection_run_id is not None  # validated at POST time
            with project.session_factory() as session:
                proj_row = session.get(ProjectionRunRow, projection_run_id)
            if proj_row is None:
                raise ValueError(f"projection run '{projection_run_id}' not found")
            proj_cache = ProjectionCache.load(project.project_dir / proj_row.npz_relpath)
            if proj_cache is None:
                raise ValueError(
                    f"coordinate cache of projection '{projection_run_id}' is missing "
                    "or damaged; recompute the projection first"
                )
            projection_signature = proj_row.source_signature
            ids = list(proj_cache.ids)
            matrix = proj_cache.coords
            if projection_signature != signature:
                # Labels describe the projection's layout, not current vectors:
                # never present that as fresh (audit #7).
                ctx.warn(
                    "the projection was built from older vectors than the current "
                    "embedding cache: clusters describe an OUTDATED layout "
                    "(the run is marked stale — recompute the projection first)"
                )
            emb_ids = set(emb_cache.ids)
            covered = sum(1 for fid in ids if fid in emb_ids)
            if covered < len(ids) or covered < len(emb_ids):
                ctx.warn(
                    f"clustering covers {len(ids)} projection points, of which "
                    f"{covered} have current embeddings ({len(emb_ids)} embedded "
                    "in total); labels exist only for the projection's points"
                )
        else:
            ids = list(emb_cache.ids)
            matrix = emb_cache.vectors

        ctx.check_cancelled()
        ctx.progress(1, 3, f"fitting DBSCAN ({metric}) on {len(ids)} points", force=True)
        started = time.monotonic()
        eps = _param_number(params, "eps", 0.5)
        min_samples = int(_param_number(params, "min_samples", 5.0))
        labels = run_dbscan(matrix, metric=metric, eps=eps, min_samples=min_samples)

        fingerprint = clustering_fingerprint(
            embedding_run_id, space, projection_run_id, algorithm, metric, params
        )
        rel_path = f"cache/clustering/{fingerprint}.npz"
        _save_labels(project.project_dir / rel_path, ids, labels)

        assigned = labels[labels >= 0]
        n_clusters = int(assigned.max()) + 1 if assigned.size else 0
        noise = int((labels == -1).sum())
        _upsert_run(
            project,
            fingerprint=fingerprint,
            embedding_run_id=embedding_run_id,
            space=space,
            projection_run_id=projection_run_id,
            algorithm=algorithm,
            metric=metric,
            params=params,
            npz_relpath=rel_path,
            count=len(ids),
            n_clusters=n_clusters,
            noise=noise,
            signature=signature,
            projection_signature=projection_signature,
        )

        ctx.check_cancelled()
        ctx.progress(3, 3, "labels ready", force=True)
        elapsed = round(time.monotonic() - started, 1)
        where = f"projection {projection_run_id}" if space == "projection" else "original vectors"
        return (
            f"DBSCAN over {where} ({metric}, eps={eps:g}, min_samples={min_samples}): "
            f"{n_clusters} clusters, {noise} noise points of {len(ids)} in {elapsed}s"
        )

    return runner


def _save_labels(path: Path, ids: list[str], labels: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".tmp.npz")
    np.savez(
        tmp,
        ids=np.array(ids, dtype=np.str_),
        labels=np.asarray(labels, dtype=np.int32),
    )
    os.replace(tmp, path)


def load_labels(path: Path) -> tuple[list[str], np.ndarray] | None:
    """Read a labels cache; None when absent or damaged (honest 409 upstream)."""
    if not path.exists():
        return None
    try:
        with np.load(path, allow_pickle=False) as data:
            ids = [str(x) for x in data["ids"]]
            labels = np.asarray(data["labels"], dtype=np.int32)
    except (KeyError, ValueError, OSError):
        return None
    if labels.shape[0] != len(ids):
        return None
    return ids, labels


def _upsert_run(
    project: ProjectContext,
    *,
    fingerprint: str,
    embedding_run_id: str,
    space: str,
    projection_run_id: str | None,
    algorithm: str,
    metric: str,
    params: dict[str, object],
    npz_relpath: str,
    count: int,
    n_clusters: int,
    noise: int,
    signature: str,
    projection_signature: str | None = None,
) -> None:
    now = _utc_now()
    with project.session_factory() as session:
        row = session.get(ClusteringRunRow, fingerprint)
        if row is None:
            row = ClusteringRunRow(
                id=fingerprint, created_at=now, embedding_run_id=embedding_run_id
            )
            session.add(row)
        row.embedding_run_id = embedding_run_id
        row.space = space
        row.projection_run_id = projection_run_id
        row.algorithm = algorithm
        row.metric = metric
        row.params_json = json.dumps(params, sort_keys=True, default=str)
        row.npz_relpath = npz_relpath
        row.count = count
        row.n_clusters = n_clusters
        row.noise = noise
        row.source_signature = signature
        row.projection_signature = projection_signature
        row.versions_json = json.dumps(clustering_versions(algorithm), sort_keys=True)
        row.updated_at = now
        session.commit()
