"""Metric endpoints (TZ §5.6): compute, inventory, detail, deletion.

Metric values are always served together with their explanation, k, sample
size and seed — a bare number without interpretation is forbidden (§12).
"""

from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from app.api.deps import get_job_manager, get_project
from app.api.errors import ApiError
from app.api.routes_embeddings import reject_if_active_job
from app.api.routes_projections import current_embedding_signature
from app.api.schemas import ComputeMetricsRequest, JobInfo, MetricRunDTO, MetricValueDTO
from app.api.serialization import job_info_from_row
from app.jobs.manager import JobManager
from app.jobs.metrics import make_metrics_runner
from app.projection_methods.cache import ProjectionCache
from app.storage.models import EmbeddingRunRow, JobRow, MetricRunRow, ProjectionRunRow
from app.storage.projects_store import ProjectContext

router = APIRouter(prefix="/api/projects/{project_id}", tags=["metrics"])


def _parse_run(row: MetricRunRow, stale: bool) -> MetricRunDTO:
    result = json.loads(row.result_json) if row.result_json else {}
    params = json.loads(row.params_json) if row.params_json else {}
    metrics_raw: dict[str, Any] = result.get("metrics") or {}
    metrics: dict[str, MetricValueDTO] = {}
    for name, data in metrics_raw.items():
        if isinstance(data, dict):
            metrics[str(name)] = MetricValueDTO(
                value=data.get("value"),
                k=data.get("k"),
                n_sampled=data.get("n_sampled"),
                n_sampled_with_relations=data.get("n_sampled_with_relations"),
                n_known_pairs_embedded=data.get("n_known_pairs_embedded"),
                n_pairs_considered=data.get("n_pairs_considered"),
                explanation=str(data.get("explanation", "")),
            )
    kinds = params.get("relation_kinds")
    return MetricRunDTO(
        id=row.id,
        embedding_run_id=row.embedding_run_id,
        projection_run_id=row.projection_run_id,
        k=row.k,
        sample_size=row.sample_size,
        seed=row.seed,
        relation_kinds=[str(x) for x in kinds] if isinstance(kinds, list) else None,
        n_vectors=row.n_vectors,
        metrics=metrics,
        warnings=[str(w) for w in (result.get("warnings") or [])],
        stale=stale,
        versions=json.loads(row.versions_json) if row.versions_json else {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.post("/metrics/compute", response_model=JobInfo, status_code=202)
def compute_metrics(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: ComputeMetricsRequest,
    manager: Annotated[JobManager, Depends(get_job_manager)],
    response: Response,
) -> JobInfo:
    """Queue a metric run (deterministic sample; results stored with params)."""
    with ctx.session_factory() as session:
        emb = session.get(EmbeddingRunRow, payload.embedding_run_id)
        if emb is None:
            raise ApiError(
                404,
                "unknown_embedding_run",
                f"Embedding run '{payload.embedding_run_id}' does not exist.",
                "Compute embeddings first (EXPERIMENTS section).",
            )
        if emb.count == 0:
            raise ApiError(
                409,
                "no_vectors",
                "The embedding run has no vectors yet.",
                "Compute embeddings first, then measure.",
            )
        if payload.projection_run_id is not None:
            proj = session.get(ProjectionRunRow, payload.projection_run_id)
            if proj is None:
                raise ApiError(
                    404,
                    "projection_not_found",
                    f"Projection '{payload.projection_run_id}' does not exist.",
                )
            if ProjectionCache.load(ctx.project_dir / proj.npz_relpath) is None:
                raise ApiError(
                    409,
                    "projection_cache_unavailable",
                    "The projection's coordinate cache is missing or damaged.",
                    "Recompute the projection before measuring it.",
                )

    reject_if_active_job(ctx, ("metrics", "embed", "projection"), "active_job_conflict")

    job_id = manager.submit(
        ctx,
        "metrics",
        make_metrics_runner(
            payload.embedding_run_id,
            payload.projection_run_id,
            payload.k,
            payload.sample,
            payload.seed,
            payload.relation_kinds,
        ),
        params={
            "embedding_run_id": payload.embedding_run_id,
            "projection_run_id": payload.projection_run_id,
            "k": payload.k,
            "sample": payload.sample,
            "seed": payload.seed,
            "relation_kinds": payload.relation_kinds,
        },
    )
    response.status_code = 202
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)


@router.get("/metrics", response_model=list[MetricRunDTO])
def list_metric_runs(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[MetricRunDTO]:
    with ctx.session_factory() as session:
        rows = session.execute(select(MetricRunRow)).scalars().all()
    signature_cache: dict[str, str | None] = {}
    result: list[MetricRunDTO] = []
    for row in rows:
        if row.embedding_run_id not in signature_cache:
            signature_cache[row.embedding_run_id] = current_embedding_signature(
                ctx, row.embedding_run_id
            )
        current = signature_cache[row.embedding_run_id]
        stale = current is None or current != row.source_signature
        result.append(_parse_run(row, stale))
    result.sort(key=lambda r: (r.updated_at, r.id), reverse=True)
    return result


@router.get("/metrics/{metric_id}", response_model=MetricRunDTO)
def get_metric_run(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    metric_id: str,
) -> MetricRunDTO:
    with ctx.session_factory() as session:
        row = session.get(MetricRunRow, metric_id)
    if row is None:
        raise ApiError(404, "metric_run_not_found", f"Metric run '{metric_id}' does not exist.")
    current = current_embedding_signature(ctx, row.embedding_run_id)
    stale = current is None or current != row.source_signature
    return _parse_run(row, stale)


@router.delete("/metrics/{metric_id}")
def delete_metric_run(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    metric_id: str,
) -> dict[str, str]:
    with ctx.session_factory() as session:
        row = session.get(MetricRunRow, metric_id)
        if row is None:
            raise ApiError(404, "metric_run_not_found", f"Metric run '{metric_id}' does not exist.")
        session.delete(row)
        session.commit()
    return {"deleted": metric_id}
