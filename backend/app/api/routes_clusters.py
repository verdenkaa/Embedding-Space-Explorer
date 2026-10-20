"""Clustering and manual-group endpoints.

Clustering:
- the space is EXPLICIT ("original" vectors with cosine/euclidean distance,
  or one projection's coordinates with euclidean) and persisted per run;
- compute is a background job (DBSCAN is fast, but the job contract keeps
  progress/cancellation uniform);
- labels live in cache/clustering/<id>.npz; identity = fingerprint, so the
  same configuration recomputes idempotently;
- staleness follows the embedding cache signature (like projections);
- noise (-1) is served as a count and label, never renamed to a "meaning".

Manual groups:
- named sets of FRAGMENT IDs from the current selection; independent of
  automatic clustering (never overwritten by it);
- members cascade with deleted fragments; counts stay honest.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from app.api.deps import get_job_manager, get_project
from app.api.errors import ApiError
from app.api.routes_embeddings import reject_if_active_job
from app.api.schemas import (
    ClusteringLabelsDTO,
    ClusteringParamsDTO,
    ClusteringRunDTO,
    ComputeClusteringRequest,
    CreateGroupRequest,
    FragmentGroupDTO,
    JobInfo,
)
from app.api.serialization import job_info_from_row
from app.jobs.clustering import load_labels, make_clustering_runner
from app.jobs.manager import JobManager, JobRunner
from app.storage.models import (
    ClusteringRunRow,
    EmbeddingRunRow,
    FragmentGroupMemberRow,
    FragmentGroupRow,
    FragmentRow,
    JobRow,
    ProjectionRunRow,
)
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache

router = APIRouter(prefix="/api/projects/{project_id}", tags=["clustering"])


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def current_embedding_signature(ctx: ProjectContext, embedding_run_id: str) -> str | None:
    """Live signature of an embedding run's vectors (None when unusable)."""
    with ctx.session_factory() as session:
        emb = session.get(EmbeddingRunRow, embedding_run_id)
    if emb is None:
        return None
    cache = NpzEmbeddingCache.load(ctx.project_dir / emb.npz_relpath)
    if len(cache) == 0:
        return None
    return cache.signature()


# ---------------------------------------------------------------------------
# Clustering runs
# ---------------------------------------------------------------------------


@router.post("/clustering/compute", response_model=JobInfo, status_code=202)
def compute_clustering(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: ComputeClusteringRequest,
    manager: Annotated[JobManager, Depends(get_job_manager)],
    response: Response,
) -> JobInfo:
    """Queue a DBSCAN job over an explicitly chosen space."""
    with ctx.session_factory() as session:
        emb_run = session.get(EmbeddingRunRow, payload.embedding_run_id)
        if emb_run is None:
            raise ApiError(
                404,
                "unknown_embedding_run",
                f"Embedding run '{payload.embedding_run_id}' does not exist.",
                "Compute embeddings first (EXPERIMENTS section).",
            )
        if emb_run.count == 0:
            raise ApiError(
                409,
                "no_vectors",
                "The embedding run has no vectors yet.",
                "Compute embeddings first, then cluster.",
            )
        if payload.space == "projection":
            if payload.projection_run_id is None:
                raise ApiError(
                    400,
                    "invalid_clustering_params",
                    "space='projection' requires projection_run_id.",
                    "Pick the projection whose coordinates should be clustered.",
                )
            proj = session.get(ProjectionRunRow, payload.projection_run_id)
            if proj is None:
                raise ApiError(
                    404,
                    "projection_not_found",
                    f"Projection '{payload.projection_run_id}' does not exist.",
                )

    metric = payload.metric
    if metric is None:
        metric = "euclidean" if payload.space == "projection" else "cosine"
    if payload.space == "projection" and metric != "euclidean":
        raise ApiError(
            400,
            "invalid_clustering_params",
            "Projection coordinates only support the euclidean metric.",
            "Cosine over projection axes is not interpretable; cluster the "
            "ORIGINAL vectors with cosine instead.",
        )

    # eps > 0 and min_samples >= 2 are enforced by the DTO schema (pydantic)
    clustering_params = payload.params or ClusteringParamsDTO(eps=0.5, min_samples=5)
    params: dict[str, object] = {
        "eps": clustering_params.eps,
        "min_samples": clustering_params.min_samples,
    }

    reject_if_active_job(ctx, ("clustering", "embed", "projection"), "active_job_conflict")

    runner: JobRunner = make_clustering_runner(
        payload.embedding_run_id,
        payload.space,
        payload.projection_run_id,
        payload.algorithm,
        metric,
        params,
    )
    job_id = manager.submit(
        ctx,
        "clustering",
        runner,
        params={
            "embedding_run_id": payload.embedding_run_id,
            "space": payload.space,
            "projection_run_id": payload.projection_run_id,
            "algorithm": payload.algorithm,
            "metric": metric,
            **params,
        },
    )
    response.status_code = 202
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)


@router.get("/clustering", response_model=list[ClusteringRunDTO])
def list_clustering_runs(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[ClusteringRunDTO]:
    import json

    with ctx.session_factory() as session:
        rows = session.execute(select(ClusteringRunRow)).scalars().all()
    signature_cache: dict[str, str | None] = {}
    result: list[ClusteringRunDTO] = []
    for row in rows:
        if row.embedding_run_id not in signature_cache:
            signature_cache[row.embedding_run_id] = current_embedding_signature(
                ctx, row.embedding_run_id
            )
        current = signature_cache[row.embedding_run_id]
        # projection-based labels describe the projection's layout: stale when
        # current vectors differ from the embedding cache OR from the vectors
        # the projection was built from (audit #7)
        stale = (
            current is None
            or current != row.source_signature
            or (row.projection_signature is not None and current != row.projection_signature)
        )
        labels = load_labels(ctx.project_dir / row.npz_relpath)
        raw_params = json.loads(row.params_json) if row.params_json else {}
        result.append(
            ClusteringRunDTO(
                id=row.id,
                embedding_run_id=row.embedding_run_id,
                space=row.space,
                projection_run_id=row.projection_run_id,
                algorithm=row.algorithm,
                metric=row.metric,
                params=ClusteringParamsDTO(
                    eps=float(raw_params.get("eps", 0.5)),
                    min_samples=int(raw_params.get("min_samples", 5)),
                ),
                count=row.count,
                n_clusters=row.n_clusters,
                noise=row.noise,
                stale=stale,
                cache_ok=labels is not None,
                versions=json.loads(row.versions_json) if row.versions_json else {},
                created_at=row.created_at,
                updated_at=row.updated_at,
            )
        )
    result.sort(key=lambda r: (r.updated_at, r.id), reverse=True)
    return result


@router.get("/clustering/{clustering_id}/labels", response_model=ClusteringLabelsDTO)
def get_clustering_labels(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    clustering_id: str,
) -> ClusteringLabelsDTO:
    with ctx.session_factory() as session:
        row = session.get(ClusteringRunRow, clustering_id)
        if row is None:
            raise ApiError(
                404, "clustering_not_found", f"Clustering run '{clustering_id}' does not exist."
            )
        npz_relpath = row.npz_relpath
        space, algorithm, metric = row.space, row.algorithm, row.metric
        n_clusters, noise = row.n_clusters, row.noise
    loaded = load_labels(ctx.project_dir / npz_relpath)
    if loaded is None:
        raise ApiError(
            409,
            "clustering_cache_unavailable",
            f"Label cache of clustering '{clustering_id}' is missing or damaged.",
            "Recompute the clustering; the original vectors are not affected.",
        )
    ids, labels = loaded
    return ClusteringLabelsDTO(
        clustering_id=clustering_id,
        space=space,
        algorithm=algorithm,
        metric=metric,
        n_clusters=n_clusters,
        noise=noise,
        count=len(ids),
        ids=ids,
        labels=[int(x) for x in labels],
    )


@router.delete("/clustering/{clustering_id}")
def delete_clustering_run(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    clustering_id: str,
) -> dict[str, str]:
    with ctx.session_factory() as session:
        row = session.get(ClusteringRunRow, clustering_id)
        if row is None:
            raise ApiError(
                404, "clustering_not_found", f"Clustering run '{clustering_id}' does not exist."
            )
        npz_relpath = row.npz_relpath
        session.delete(row)
        session.commit()
    (ctx.project_dir / npz_relpath).unlink(missing_ok=True)
    return {"deleted": clustering_id}


# ---------------------------------------------------------------------------
# Manual groups
# ---------------------------------------------------------------------------


@router.get("/groups", response_model=list[FragmentGroupDTO])
def list_groups(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[FragmentGroupDTO]:
    with ctx.session_factory() as session:
        groups = (
            session.execute(select(FragmentGroupRow).order_by(FragmentGroupRow.name))
            .scalars()
            .all()
        )
        members = session.execute(select(FragmentGroupMemberRow)).scalars().all()
    by_group: dict[str, list[str]] = {}
    for member in members:
        by_group.setdefault(member.group_id, []).append(member.fragment_id)
    return [
        FragmentGroupDTO(
            id=g.id,
            name=g.name,
            count=len(by_group.get(g.id, [])),
            fragment_ids=by_group.get(g.id, []),
            created_at=g.created_at,
        )
        for g in groups
    ]


@router.post("/groups", response_model=FragmentGroupDTO, status_code=201)
def create_group(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: CreateGroupRequest,
) -> FragmentGroupDTO:
    name = payload.name.strip()
    if not name:
        raise ApiError(400, "invalid_group_name", "Group name must not be empty.")
    unique_ids = list(dict.fromkeys(payload.fragment_ids))
    with ctx.session_factory() as session:
        existing = session.execute(
            select(FragmentGroupRow).where(FragmentGroupRow.name == name)
        ).scalar_one_or_none()
        if existing is not None:
            raise ApiError(
                409,
                "group_name_taken",
                f"A group named '{name}' already exists in this project.",
                "Choose another name or delete the existing group first.",
            )
        found = set(
            session.execute(select(FragmentRow.id).where(FragmentRow.id.in_(unique_ids))).scalars()
        )
        unknown = [fid for fid in unique_ids if fid not in found]
        if unknown:
            raise ApiError(
                400,
                "unknown_fragments",
                f"{len(unknown)} fragment(s) do not exist (e.g. '{unknown[0]}').",
                "The selection outlived a reindex; refresh the selection and retry.",
            )
        group = FragmentGroupRow(id=uuid.uuid4().hex[:12], name=name, created_at=_utc_now())
        session.add(group)
        # no relationship() between the mappers → flush order is not derived
        # automatically; the parent row must exist before the members
        session.flush()
        for fragment_id in unique_ids:
            session.add(FragmentGroupMemberRow(group_id=group.id, fragment_id=fragment_id))
        session.commit()
    return FragmentGroupDTO(
        id=group.id,
        name=group.name,
        count=len(unique_ids),
        fragment_ids=unique_ids,
        created_at=group.created_at,
    )


@router.delete("/groups/{group_id}")
def delete_group(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    group_id: str,
) -> dict[str, str]:
    with ctx.session_factory() as session:
        row = session.get(FragmentGroupRow, group_id)
        if row is None:
            raise ApiError(404, "group_not_found", f"Group '{group_id}' does not exist.")
        session.delete(row)
        session.commit()
    return {"deleted": group_id}
