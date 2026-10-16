"""Projection jobs: compute 2D/3D/4D display coordinates from stored vectors.

Design notes (TZ §5.2, §9.3):
- one job computes every requested spec (by default the [3, 2] pair, for
  raw_axes also several axis pairs compared side by side) → one projection
  run row + one .npz per spec;
- source vectors are READ ONLY: a projection never touches the embedding
  cache, so UMAP parameters can never invalidate original vectors;
- the run stores the embedding cache signature at compute time; when vectors
  change later (reindex/prune/recompute), the inventory marks the projection
  stale instead of silently showing an outdated map;
- cancellation is checked between stages (fits themselves are not
  interruptible — documented honestly in the UI);
- UMAP with a fixed seed is deterministic but single-threaded and may take
  seconds-to-minutes on large corpora (numba); progress messages say so.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime

import numpy as np
from sqlalchemy import func, select

from app.jobs.manager import JobContext, JobRunner
from app.projection_methods.base import ProjectionResult, projection_fingerprint
from app.projection_methods.cache import ProjectionCache
from app.projection_methods.registry import library_versions, require_method
from app.storage.models import EmbeddingRunRow, FileRow, FragmentRow, ProjectionRunRow
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def make_projection_runner(
    embedding_run_id: str,
    method_id: str,
    specs: list[tuple[int, dict[str, object]]],
    seed: int,
) -> JobRunner:
    """Runner over an explicit list of (n_components, params) specs.

    One job can produce several projection runs: the usual [3, 2] pair of a
    method, a single raw-axes set, or several raw-axes PAIRS compared side
    by side (multi-plot 2D). Every spec gets its own fingerprint/cache/row.
    """

    def runner(ctx: JobContext) -> str:
        project = ctx.project
        method = require_method(method_id)  # validated at POST time; re-checked here
        if not specs:
            raise ValueError("projection job without specs")
        if not method.is_available():
            raise RuntimeError(
                f"projection method '{method.display_name}' is unavailable: "
                "its runtime is not installed (run scripts/dev.bat)"
            )

        with project.session_factory() as session:
            emb_run = session.get(EmbeddingRunRow, embedding_run_id)
            if emb_run is None:
                raise ValueError(
                    f"embedding run '{embedding_run_id}' not found; "
                    "compute embeddings first (EXPERIMENTS section)"
                )
            npz_relpath = emb_run.npz_relpath
            total_fragments = session.execute(
                select(func.count(FragmentRow.id))
                .join(FileRow, FileRow.id == FragmentRow.file_id)
                .where(FileRow.status == "indexed")
            ).scalar_one()

        ctx.progress(0, len(specs), "loading vectors", force=True)
        vectors_cache = NpzEmbeddingCache.load(project.project_dir / npz_relpath)
        if len(vectors_cache) == 0:
            raise ValueError("the embedding run has no vectors; compute embeddings first")
        signature = vectors_cache.signature()
        if len(vectors_cache) < total_fragments:
            ctx.warn(
                f"projection covers {len(vectors_cache)} of {total_fragments} fragments: "
                "some fragments have no embeddings yet (compute to see them on the map)"
            )

        ids = list(vectors_cache.ids)
        vectors = vectors_cache.vectors
        started = time.monotonic()
        made: list[str] = []
        for stage, (n_components, spec_params) in enumerate(specs):
            ctx.check_cancelled()
            normalized = method.validate_params(spec_params)
            label = f"{method.display_name}-{n_components}D"
            if method_id == "raw_axes":
                axes_obj = normalized.get("axes", [])
                axes_list = [int(a) for a in axes_obj] if isinstance(axes_obj, list) else []
                label += f" [{', '.join(str(a) for a in axes_list)}]"
            hint = " (first UMAP run is slower: numba compilation)" if method_id == "umap" else ""
            ctx.progress(
                stage,
                len(specs),
                f"fitting {label} on {len(ids)}×{vectors.shape[1]} vectors{hint}",
                force=True,
            )
            result: ProjectionResult = method.fit(
                vectors, n_components=n_components, params=normalized, seed=seed
            )
            fingerprint = projection_fingerprint(
                embedding_run_id, method_id, n_components, normalized, seed
            )
            rel_path = f"cache/projections/{fingerprint}.npz"
            ProjectionCache(
                path=project.project_dir / rel_path,
                ids=ids,
                coords=result.coords,
                axis_info=(
                    None
                    if result.axis_info is None
                    else np.array(result.axis_info, dtype=np.float32)
                ),
            ).save()
            _upsert_run(
                project,
                fingerprint=fingerprint,
                embedding_run_id=embedding_run_id,
                method_id=method_id,
                n_components=n_components,
                params=normalized,
                seed=seed,
                result=result,
                npz_relpath=rel_path,
                count=len(ids),
                signature=signature,
            )
            made.append(label)
            ctx.progress(stage + 1, len(specs), f"{label} ready", force=True)

        ctx.check_cancelled()
        elapsed = round(time.monotonic() - started, 1)
        return (
            f"projection {', '.join(made)} computed over {len(ids)} vectors "
            f"({method.display_name}, seed {seed}) in {elapsed}s"
        )

    return runner


def _upsert_run(
    project: ProjectContext,
    *,
    fingerprint: str,
    embedding_run_id: str,
    method_id: str,
    n_components: int,
    params: dict[str, object],
    seed: int,
    result: ProjectionResult,
    npz_relpath: str,
    count: int,
    signature: str,
) -> None:
    now = _utc_now()
    with project.session_factory() as session:
        row = session.get(ProjectionRunRow, fingerprint)
        if row is None:
            row = ProjectionRunRow(
                id=fingerprint, created_at=now, embedding_run_id=embedding_run_id
            )
            session.add(row)
        row.embedding_run_id = embedding_run_id
        row.method = method_id
        row.n_components = n_components
        row.params_json = json.dumps(params, sort_keys=True, default=str)
        row.seed = seed
        row.axis_labels_json = json.dumps(list(result.axis_labels), ensure_ascii=False)
        row.axis_info_json = (
            None if result.axis_info is None else json.dumps(list(result.axis_info))
        )
        row.versions_json = json.dumps(library_versions(method_id), sort_keys=True)
        row.npz_relpath = npz_relpath
        row.count = count
        row.source_signature = signature
        row.updated_at = now
        session.commit()
