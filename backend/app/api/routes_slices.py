"""Slice endpoints: mathematical layer selection in the ORIGINAL space.

A slice is a sample of points in a slab around a hyperplane defined
in the original D-dimensional space — d(x) = dot(x - p, n), membership
|d(x)| <= t/2. It is computed synchronously over the stored vectors (one
N×D dot product — milliseconds for a research corpus), and the response
carries the coordinate along the normal for EVERY fragment so each view can
mask the layer over whichever projection is active. Honesty: the selection
happens in the original space; the DISPLAY always goes through a projection
and the UI must say so — the response carries the note, and saved slices
persist the RESOLVED unit normal (exact D-dim vector) AND the ABSOLUTE plane
coordinate `plane_offset = dot(x, n)` — the relative `position` is measured
from the run's centroid, which is data-dependent, so without the absolute
anchor the same saved slice would silently select a different hyperplane
after the corpus changes (audit #6). Applying a saved slice reports the
centroid drift instead of hiding it.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.schemas import (
    ComputeSliceRequest,
    CreateSliceRequest,
    SavedSliceDTO,
    SliceComputeResponse,
)
from app.slice_engine.engine import SliceParamsError, compute_slice, resolve_normal
from app.storage.models import EmbeddingRunRow, SavedSliceRow
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache

router = APIRouter(prefix="/api/projects/{project_id}", tags=["slices"])

NOTE = (
    "Срез — математическая выборка слоя в ИСХОДНОМ D-мерном пространстве "
    "(|dot(x - p, n)| <= t/2); показаны точки через активную проекцию — "
    "это не «срез картинки» и не clipping plane."
)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _load_run_vectors(
    ctx: ProjectContext, embedding_run_id: str
) -> tuple[NpzEmbeddingCache, EmbeddingRunRow]:
    with ctx.session_factory() as session:
        run = session.get(EmbeddingRunRow, embedding_run_id)
    if run is None:
        raise ApiError(
            404,
            "unknown_embedding_run",
            f"Embedding run '{embedding_run_id}' does not exist.",
            "Compute embeddings first (EXPERIMENTS section).",
        )
    cache = NpzEmbeddingCache.load(ctx.project_dir / run.npz_relpath)
    if len(cache) == 0:
        raise ApiError(
            409,
            "no_vectors",
            "The embedding run has no vectors yet.",
            "Compute embeddings first, then define the slice.",
        )
    return cache, run


@router.post("/slices/compute", response_model=SliceComputeResponse)
def compute_slice_endpoint(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: ComputeSliceRequest,
) -> SliceComputeResponse:
    cache, _ = _load_run_vectors(ctx, payload.embedding_run_id)
    try:
        normal = resolve_normal(
            payload.normal.kind, payload.normal.index, payload.normal.vector, cache.vectors
        )
        result = compute_slice(
            cache.vectors,
            normal,
            payload.position,
            payload.thickness,
            plane_offset=payload.plane_offset,
        )
    except SliceParamsError as exc:
        raise ApiError(400, "invalid_slice_params", str(exc)) from None

    # Serve rounded coordinates and derive membership from the ROUNDED values
    # so the client mask (built from this response) can never disagree with
    # the reported count at a boundary. Membership uses the EFFECTIVE
    # position (re-based onto the current centroid when a saved absolute
    # plane_offset was given).
    u_rounded = [round(float(x), 6) for x in result.u]
    half = payload.thickness / 2.0
    in_layer = sum(1 for x in u_rounded if abs(x - result.position_used) <= half)
    drift = result.position_used - payload.position if payload.plane_offset is not None else None
    return SliceComputeResponse(
        embedding_run_id=payload.embedding_run_id,
        normal_kind=payload.normal.kind,
        normal_index=payload.normal.index,
        dim=int(cache.dim),
        position=result.position_used,
        thickness=payload.thickness,
        centroid_offset=result.centroid_offset,
        plane_offset=result.plane_offset,
        drift=drift,
        total=len(u_rounded),
        in_layer=in_layer,
        u_min=min(u_rounded) if u_rounded else 0.0,
        u_max=max(u_rounded) if u_rounded else 0.0,
        ids=list(cache.ids),
        u=u_rounded,
        note=NOTE,
    )


@router.get("/slices", response_model=list[SavedSliceDTO])
def list_saved_slices(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[SavedSliceDTO]:
    with ctx.session_factory() as session:
        rows = (
            session.execute(select(SavedSliceRow).order_by(SavedSliceRow.created_at.desc()))
            .scalars()
            .all()
        )
    return [
        SavedSliceDTO(
            id=row.id,
            name=row.name,
            embedding_run_id=row.embedding_run_id,
            normal_kind=row.normal_kind,
            normal_index=row.normal_index,
            dim=row.dim,
            vector=json.loads(row.normal_json),
            position=row.position,
            thickness=row.thickness,
            plane_offset=row.plane_offset,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post("/slices", response_model=SavedSliceDTO, status_code=201)
def save_slice(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: CreateSliceRequest,
) -> SavedSliceDTO:
    """Persist a slice definition with its RESOLVED unit normal AND the
    absolute plane coordinate (reproducible across corpus changes)."""
    cache, _ = _load_run_vectors(ctx, payload.embedding_run_id)
    try:
        normal = resolve_normal(
            payload.normal.kind, payload.normal.index, payload.normal.vector, cache.vectors
        )
        # anchor the plane in absolute coordinates: the centroid is
        # data-dependent, `position` alone would drift with the corpus
        probe = compute_slice(cache.vectors, normal, payload.position, payload.thickness)
        plane_offset = probe.plane_offset
    except SliceParamsError as exc:
        raise ApiError(400, "invalid_slice_params", str(exc)) from None

    name = payload.name.strip()
    if not name:
        raise ApiError(400, "invalid_slice_name", "Slice name must not be empty.")
    with ctx.session_factory() as session:
        existing = session.execute(
            select(SavedSliceRow).where(SavedSliceRow.name == name)
        ).scalar_one_or_none()
        if existing is not None:
            raise ApiError(
                409,
                "slice_name_taken",
                f"A saved slice named '{name}' already exists in this project.",
                "Choose another name or delete the existing slice first.",
            )
        row = SavedSliceRow(
            id=uuid.uuid4().hex[:12],
            name=name,
            embedding_run_id=payload.embedding_run_id,
            normal_kind=payload.normal.kind,
            normal_index=payload.normal.index,
            normal_json=json.dumps([round(float(v), 8) for v in normal]),
            dim=int(cache.dim),
            position=payload.position,
            thickness=payload.thickness,
            plane_offset=plane_offset,
            created_at=_utc_now(),
        )
        session.add(row)
        session.commit()
    return SavedSliceDTO(
        id=row.id,
        name=row.name,
        embedding_run_id=row.embedding_run_id,
        normal_kind=row.normal_kind,
        normal_index=row.normal_index,
        dim=row.dim,
        vector=json.loads(row.normal_json),
        position=row.position,
        thickness=row.thickness,
        plane_offset=row.plane_offset,
        created_at=row.created_at,
    )


@router.delete("/slices/{slice_id}")
def delete_saved_slice(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    slice_id: str,
) -> dict[str, str]:
    with ctx.session_factory() as session:
        row = session.get(SavedSliceRow, slice_id)
        if row is None:
            raise ApiError(404, "slice_not_found", f"Saved slice '{slice_id}' does not exist.")
        session.delete(row)
        session.commit()
    return {"deleted": slice_id}
