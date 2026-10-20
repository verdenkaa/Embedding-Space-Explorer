"""Embedding endpoints: model catalog/download, compute runs, inventory."""

from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from app.api.deps import get_job_manager, get_project, get_settings
from app.api.errors import ApiError
from app.api.schemas import (
    ComputeEmbeddingsRequest,
    CoverageDTO,
    DownloadModelRequest,
    EmbeddingRunDTO,
    JobInfo,
    ModelInfoDTO,
    PreparationPreviewsDTO,
)
from app.api.serialization import job_info_from_row
from app.config import Settings
from app.embedding_providers.preparation import MODE_CONTEXT, MODE_RAW, render_template_preview
from app.embedding_providers.registry import MODEL_CATALOG, create_provider, get_model_info
from app.jobs.embedding import make_download_runner, make_embed_runner
from app.jobs.manager import JobManager
from app.storage.models import EmbeddingRunRow, FileRow, FragmentRow, JobRow
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache

models_router = APIRouter(prefix="/api/models", tags=["models"])
preparation_router = APIRouter(prefix="/api/embeddings", tags=["embeddings"])
embeddings_router = APIRouter(prefix="/api/projects/{project_id}", tags=["embeddings"])


@preparation_router.get("/preparation-preview", response_model=PreparationPreviewsDTO)
def preparation_preview() -> PreparationPreviewsDTO:
    """Show exactly what text will be embedded in each mode."""
    return PreparationPreviewsDTO(
        raw_fragment=render_template_preview(MODE_RAW),
        context_enriched=render_template_preview(MODE_CONTEXT),
    )


@models_router.get("", response_model=list[ModelInfoDTO])
def list_models(
    settings: Annotated[Settings, Depends(get_settings)],
) -> list[ModelInfoDTO]:
    """Catalog with honest per-model download status (cheap dir check)."""
    result: list[ModelInfoDTO] = []
    for info in MODEL_CATALOG:
        provider = create_provider(info.model_id, settings.data_dir)
        result.append(
            ModelInfoDTO(
                model_id=info.model_id,
                display_name=info.display_name,
                dim=info.dim,
                approx_download_mb=info.approx_download_mb,
                description=info.description,
                is_default=info.is_default,
                downloaded=provider.is_downloaded(),
            )
        )
    return result


def reject_if_active_job(ctx: ProjectContext, kinds: tuple[str, ...], code: str) -> None:
    with ctx.session_factory() as session:
        active = (
            session.execute(
                select(JobRow).where(
                    JobRow.kind.in_(kinds), JobRow.state.in_(("queued", "running"))
                )
            )
            .scalars()
            .first()
        )
    if active is not None:
        raise ApiError(
            409,
            code,
            f"An active job '{active.kind}' ({active.state}) is already running.",
            "Wait for it to finish or cancel it first.",
        )


@embeddings_router.post("/models/download", response_model=JobInfo, status_code=202)
def download_model(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: DownloadModelRequest,
    manager: Annotated[JobManager, Depends(get_job_manager)],
    response: Response,
) -> JobInfo:
    if get_model_info(payload.model_id) is None:
        raise ApiError(
            404,
            "unknown_model",
            f"Model '{payload.model_id}' is not in the catalog.",
            "See GET /api/models for available models.",
        )
    reject_if_active_job(ctx, ("model_download", "embed", "projection"), "embedding_job_active")
    job_id = manager.submit(
        ctx,
        "model_download",
        make_download_runner(payload.model_id),
        params={"model_id": payload.model_id},
    )
    response.status_code = 202
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)


@embeddings_router.post("/embeddings/compute", response_model=JobInfo, status_code=202)
def compute_embeddings(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: ComputeEmbeddingsRequest,
    manager: Annotated[JobManager, Depends(get_job_manager)],
    response: Response,
) -> JobInfo:
    if get_model_info(payload.model_id) is None:
        raise ApiError(404, "unknown_model", f"Model '{payload.model_id}' is not in the catalog.")
    reject_if_active_job(ctx, ("model_download", "embed", "projection"), "embedding_job_active")
    job_id = manager.submit(
        ctx,
        "embed",
        make_embed_runner(payload.model_id, payload.mode, payload.batch_size),
        params={
            "model_id": payload.model_id,
            "mode": payload.mode,
            "batch_size": payload.batch_size,
        },
    )
    response.status_code = 202
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)


@embeddings_router.get("/embeddings", response_model=list[EmbeddingRunDTO])
def list_embedding_runs(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[EmbeddingRunDTO]:
    """Run inventory with live coverage (embedded / stale / missing)."""
    with ctx.session_factory() as session:
        runs = session.execute(select(EmbeddingRunRow)).scalars().all()
        if not runs:
            return []
        frag_hashes = dict(
            session.execute(
                select(FragmentRow.id, FragmentRow.content_hash)
                .join(FileRow, FileRow.id == FragmentRow.file_id)
                .where(FileRow.status == "indexed")
            ).all()
        )

    total = len(frag_hashes)
    result: list[EmbeddingRunDTO] = []
    for run in runs:
        cache = NpzEmbeddingCache.load(ctx.project_dir / run.npz_relpath)
        embedded = 0
        stale = 0
        for fid, fhash in zip(cache.ids, cache.frag_hashes, strict=True):
            current = frag_hashes.get(fid)
            if current is not None and current == fhash:
                embedded += 1
            else:
                stale += 1
        info = get_model_info(run.model_id)
        try:
            params: dict[str, int | bool | str] = json.loads(run.params_json)
        except json.JSONDecodeError:  # pragma: no cover - defensive
            params = {}
        result.append(
            EmbeddingRunDTO(
                id=run.id,
                model_id=run.model_id,
                model_display_name=info.display_name if info else run.model_id,
                dim=run.dim,
                mode=run.mode,  # type: ignore[arg-type]
                template_preview=render_template_preview(run.mode),
                params=params,
                count=run.count,
                truncated_count=run.truncated_count,
                coverage=CoverageDTO(
                    fragments_total=total,
                    embedded=embedded,
                    stale=stale,
                    missing=max(0, total - embedded),
                ),
                created_at=run.created_at,
                updated_at=run.updated_at,
            )
        )
    result.sort(key=lambda r: r.updated_at, reverse=True)
    return result
