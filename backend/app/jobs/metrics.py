"""Metric jobs: quality numbers of a projection and agreement of
original-space neighbors with known structural relations.

Design notes:
- everything is computed from STORED artifacts (embedding .npz, projection
  .npz, relations table) — no re-embedding, no hidden state;
- the sample is deterministic (seed) and its size is persisted with the
  result: a metric without its parameters is not interpretable;
- projection coordinates are aligned to embedding ids by INTERSECTION; a
  mismatch (orphans, an older projection) is reported as a warning, never
  silently ignored;
- identity = fingerprint(emb, proj, k, sample, seed, kinds): recompute is
  idempotent; staleness follows the embedding signature like everything else.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Sequence
from datetime import UTC, datetime

import numpy as np
from sqlalchemy import select

from app.jobs.manager import JobContext, JobRunner
from app.metrics.compute import MetricsInputError, compute_metric_bundle, relation_pairs_from_rows
from app.projection_methods.cache import ProjectionCache
from app.storage.models import EmbeddingRunRow, MetricRunRow, ProjectionRunRow, RelationRow
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def metric_fingerprint(
    embedding_run_id: str,
    projection_run_id: str | None,
    k: int,
    sample: int,
    seed: int,
    relation_kinds: Sequence[str] | None,
) -> str:
    payload = "\n".join(
        [
            f"emb={embedding_run_id}",
            f"proj={projection_run_id or ''}",
            f"k={k}",
            f"sample={sample}",
            f"seed={seed}",
            f"kinds={','.join(sorted(relation_kinds)) if relation_kinds else 'all'}",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def metric_versions() -> dict[str, str]:
    import contextlib
    from importlib import metadata

    versions: dict[str, str] = {"numpy": np.__version__}
    for dist in ("scikit-learn",):
        with contextlib.suppress(metadata.PackageNotFoundError):
            versions[dist] = metadata.version(dist)
    return versions


def make_metrics_runner(
    embedding_run_id: str,
    projection_run_id: str | None,
    k: int,
    sample: int,
    seed: int,
    relation_kinds: list[str] | None,
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
            proj_npz: str | None = None
            if projection_run_id is not None:
                proj_row = session.get(ProjectionRunRow, projection_run_id)
                if proj_row is None:
                    raise ValueError(f"projection run '{projection_run_id}' not found")
                proj_npz = proj_row.npz_relpath
            relation_rows = session.execute(
                select(
                    RelationRow.source_fragment_id,
                    RelationRow.target_fragment_id,
                    RelationRow.source_file_id,
                    RelationRow.target_file_id,
                    RelationRow.kind,
                )
            ).all()

        ctx.progress(0, 3, "loading vectors", force=True)
        emb_cache = NpzEmbeddingCache.load(project.project_dir / emb_npz)
        if len(emb_cache) == 0:
            raise ValueError("the embedding run has no vectors; compute embeddings first")
        signature = emb_cache.signature()
        ids = list(emb_cache.ids)
        vectors = emb_cache.vectors

        coords: np.ndarray | None = None
        warnings: list[str] = []
        if proj_npz is not None:
            proj_cache = ProjectionCache.load(project.project_dir / proj_npz)
            if proj_cache is None:
                raise ValueError(
                    f"coordinate cache of projection '{projection_run_id}' is missing "
                    "or damaged; recompute the projection first"
                )
            proj_index = {fid: i for i, fid in enumerate(proj_cache.ids)}
            keep = [i for i, fid in enumerate(ids) if fid in proj_index]
            if len(keep) < len(ids):
                warnings.append(
                    f"projection covers {len(keep)} of {len(ids)} embedded fragments; "
                    "metrics computed over the intersection"
                )
            if len(keep) == 0:
                raise ValueError("projection and embedding runs share no fragments")
            ids = [ids[i] for i in keep]
            vectors = vectors[np.asarray(keep, dtype=np.int64)]
            coords = proj_cache.coords[np.asarray([proj_index[f] for f in ids], dtype=np.int64)]

        pairs = relation_pairs_from_rows(relation_rows, relation_kinds)

        ctx.check_cancelled()
        ctx.progress(
            1,
            3,
            f"computing metrics (k={k}, sample={sample}) over {len(ids)} vectors",
            force=True,
        )
        started = time.monotonic()
        try:
            bundle = compute_metric_bundle(
                vectors=vectors,
                coords=coords,
                ids=ids,
                k=k,
                sample=sample,
                seed=seed,
                pairs=pairs,
            )
        except MetricsInputError as exc:
            raise ValueError(str(exc)) from exc
        bundle_warnings = bundle.get("warnings") or []
        assert isinstance(bundle_warnings, list)
        all_warnings = warnings + [str(w) for w in bundle_warnings]

        fingerprint = metric_fingerprint(
            embedding_run_id, projection_run_id, k, sample, seed, relation_kinds
        )
        params: dict[str, object] = {
            "embedding_run_id": embedding_run_id,
            "projection_run_id": projection_run_id,
            "k": k,
            "sample": sample,
            "seed": seed,
            "relation_kinds": relation_kinds,
        }
        result = {**bundle, "warnings": all_warnings}
        _upsert_run(
            project,
            fingerprint=fingerprint,
            embedding_run_id=embedding_run_id,
            projection_run_id=projection_run_id,
            k=k,
            sample=sample,
            seed=seed,
            params=params,
            result=result,
            n_vectors=len(ids),
            signature=signature,
        )

        ctx.check_cancelled()
        ctx.progress(3, 3, "metrics ready", force=True)
        elapsed = round(time.monotonic() - started, 1)
        metrics = result["metrics"]
        assert isinstance(metrics, dict)
        summary = ", ".join(
            f"{name}={data['value']:.3f}"
            for name, data in metrics.items()
            if isinstance(data, dict) and isinstance(data.get("value"), (int, float))
        )
        return f"metrics over {len(ids)} vectors in {elapsed}s: {summary or 'none computed'}"

    return runner


def _upsert_run(
    project: ProjectContext,
    *,
    fingerprint: str,
    embedding_run_id: str,
    projection_run_id: str | None,
    k: int,
    sample: int,
    seed: int,
    params: dict[str, object],
    result: dict[str, object],
    n_vectors: int,
    signature: str,
) -> None:
    now = _utc_now()
    with project.session_factory() as session:
        row = session.get(MetricRunRow, fingerprint)
        if row is None:
            row = MetricRunRow(id=fingerprint, created_at=now, embedding_run_id=embedding_run_id)
            session.add(row)
        row.embedding_run_id = embedding_run_id
        row.projection_run_id = projection_run_id
        row.k = k
        row.sample_size = sample
        row.seed = seed
        row.params_json = json.dumps(params, sort_keys=True, default=str)
        row.result_json = json.dumps(result, ensure_ascii=False, default=str)
        row.n_vectors = n_vectors
        row.source_signature = signature
        row.versions_json = json.dumps(metric_versions(), sort_keys=True)
        row.updated_at = now
        session.commit()
