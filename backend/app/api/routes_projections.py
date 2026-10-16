"""Projection endpoints: method catalog, compute, inventory, point clouds.

Points are served WITH full traceability metadata (file, symbol, lines) so
the frontend never needs a second round-trip to open the source of a
selected point (TZ §3, scenario B).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import get_job_manager, get_project
from app.api.errors import ApiError
from app.api.routes_embeddings import reject_if_active_job
from app.api.schemas import (
    ComputeProjectionRequest,
    CreatePresetRequest,
    JobInfo,
    ProjectionMethodInfoDTO,
    ProjectionParamSpecDTO,
    ProjectionPointDTO,
    ProjectionPointsDTO,
    ProjectionPresetDTO,
    ProjectionRunDTO,
)
from app.api.serialization import job_info_from_row
from app.jobs.manager import JobManager
from app.jobs.projection import make_projection_runner
from app.projection_methods.base import (
    SUPPORTED_COMPONENTS,
    ProjectionParamsError,
    normalize_components,
)
from app.projection_methods.cache import ProjectionCache
from app.projection_methods.registry import METHODS, get_method
from app.storage.models import (
    EmbeddingRunRow,
    FileRow,
    FragmentRow,
    JobRow,
    ProjectionPresetRow,
    ProjectionRunRow,
)
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache

methods_router = APIRouter(prefix="/api/projections", tags=["projections"])
projections_router = APIRouter(prefix="/api/projects/{project_id}", tags=["projections"])

#: SQLite bound-parameter safety margin for chunked IN(…) queries.
_META_CHUNK = 400


@methods_router.get("/methods", response_model=list[ProjectionMethodInfoDTO])
def list_projection_methods() -> list[ProjectionMethodInfoDTO]:
    """Catalog with honest availability and parameter specs for the UI form."""
    result: list[ProjectionMethodInfoDTO] = []
    for method in METHODS:
        result.append(
            ProjectionMethodInfoDTO(
                method_id=method.method_id,
                display_name=method.display_name,
                description=method.description,
                caveat=method.caveat,
                available=method.is_available(),
                supported_components=list(SUPPORTED_COMPONENTS),
                params=[
                    ProjectionParamSpecDTO(
                        name=spec.name,
                        type=spec.type,
                        default=spec.default,
                        description=spec.description,
                        min_value=spec.min_value,
                        max_value=spec.max_value,
                        step=spec.step,
                        choices=list(spec.choices) if spec.choices else None,
                        min_items=spec.min_items,
                        max_items=spec.max_items,
                    )
                    for spec in method.param_specs
                ],
            )
        )
    return result


def _parse_json(raw: str | None, fallback: object) -> object:
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:  # pragma: no cover - defensive
        return fallback


def _method_display_name(method_id: str) -> str:
    method = get_method(method_id)
    return method.display_name if method else method_id


def _validated_axes(normalized: dict[str, object], run_dim: int) -> list[int]:
    """Range-check the selected raw axes against the run's dimensionality."""
    raw = normalized.get("axes", [])
    if not isinstance(raw, list):
        raise ProjectionParamsError("parameter 'axes' must be a list of integers")
    axes = [int(a) for a in raw]
    if run_dim > 0:
        out_of_range = [a for a in axes if a < 0 or a >= run_dim]
        if out_of_range:
            raise ProjectionParamsError(
                f"axis indices out of range 0..{run_dim - 1}: {out_of_range}"
            )
    return axes


@projections_router.post("/projections/compute", response_model=JobInfo, status_code=202)
def compute_projection(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: ComputeProjectionRequest,
    manager: Annotated[JobManager, Depends(get_job_manager)],
    response: Response,
) -> JobInfo:
    """Queue a projection job (3D and/or 2D coordinates over stored vectors).

    Parameters are validated BEFORE queueing so typos/range errors give an
    immediate 400 instead of a failed job (TZ §12).
    """
    method = get_method(payload.method)
    if method is None:
        raise ApiError(
            404,
            "unknown_projection_method",
            f"Projection method '{payload.method}' is not in the catalog.",
            "See GET /api/projections/methods for available methods.",
        )
    if not method.is_available():
        raise ApiError(
            409,
            "projection_method_unavailable",
            f"Method '{method.display_name}' cannot be used: its runtime is not installed.",
            "Reinstall backend dependencies (scripts\\dev.bat or "
            "pip install -r backend/requirements.txt).",
        )
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
                "Compute embeddings first, then build the projection.",
            )
        run_dim = emb_run.dim

    try:
        specs: list[tuple[int, dict[str, object]]]
        if payload.axis_sets is not None:
            if method.method_id != "raw_axes":
                raise ProjectionParamsError(
                    f"axis_sets is supported only by the raw_axes method (got '{method.method_id}')"
                )
            if "axes" in payload.params:
                raise ProjectionParamsError(
                    "params.axes must not be combined with axis_sets "
                    "(axis_sets already defines the axes of every plot)"
                )
            # Multi-plot 2D comparison: one spec (2 components) per axis pair.
            specs = []
            for axis_pair in payload.axis_sets:
                pair_params = dict(payload.params)
                pair_params["axes"] = list(axis_pair)
                normalized_pair = method.validate_params(pair_params)
                _validated_axes(normalized_pair, run_dim)
                specs.append((2, normalized_pair))
        else:
            normalized = method.validate_params(payload.params)
            if method.method_id == "raw_axes":
                axes = _validated_axes(normalized, run_dim)
                # One display coordinate per selected axis — components are
                # DERIVED, never guessed (a 2-axis preset cannot fill the 3D
                # view; 4 axes feed the 4D view).
                specs = [(len(axes), normalized)]
            else:
                wanted = normalize_components(payload.components)
                specs = [(n, normalized) for n in wanted]
    except ProjectionParamsError as exc:
        raise ApiError(400, "invalid_projection_params", str(exc)) from None

    # A projection must not race embedding recomputation or another fit.
    reject_if_active_job(ctx, ("projection", "embed", "model_download"), "projection_job_active")

    job_params: dict[str, object] = {
        "embedding_run_id": payload.embedding_run_id,
        "method": method.method_id,
        "components": sorted({n for n, _ in specs}, reverse=True),
        "seed": payload.seed,
    }
    if payload.axis_sets is not None:
        job_params["axis_sets"] = [list(s) for s in payload.axis_sets]
        job_params["params"] = {
            k: v for k, v in specs[0][1].items() if k != "axes"
        }  # shared non-axis params (e.g. standardize)
    else:
        job_params["params"] = specs[0][1]

    job_id = manager.submit(
        ctx,
        "projection",
        make_projection_runner(payload.embedding_run_id, method.method_id, specs, payload.seed),
        params=job_params,
    )
    response.status_code = 202
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)


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


@projections_router.get("/projections", response_model=list[ProjectionRunDTO])
def list_projections(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[ProjectionRunDTO]:
    """Projection inventory with live staleness against current vectors."""
    with ctx.session_factory() as session:
        rows = session.execute(select(ProjectionRunRow)).scalars().all()
    if not rows:
        return []

    signature_cache: dict[str, str | None] = {}
    result: list[ProjectionRunDTO] = []
    for row in rows:
        if row.embedding_run_id not in signature_cache:
            signature_cache[row.embedding_run_id] = current_embedding_signature(
                ctx, row.embedding_run_id
            )
        current = signature_cache[row.embedding_run_id]
        cache_ok = ProjectionCache.load(ctx.project_dir / row.npz_relpath) is not None
        stale = current is None or current != row.source_signature
        params = _parse_json(row.params_json, {})
        result.append(
            ProjectionRunDTO(
                id=row.id,
                embedding_run_id=row.embedding_run_id,
                method=row.method,
                method_display_name=_method_display_name(row.method),
                n_components=row.n_components,
                params=params,  # type: ignore[arg-type]
                seed=row.seed,
                axis_labels=_parse_json(row.axis_labels_json, []),  # type: ignore[arg-type]
                axis_info=_parse_json(row.axis_info_json, None),  # type: ignore[arg-type]
                count=row.count,
                stale=stale,
                cache_ok=cache_ok,
                versions=_parse_json(row.versions_json, {}),  # type: ignore[arg-type]
                created_at=row.created_at,
                updated_at=row.updated_at,
            )
        )
    result.sort(key=lambda r: (r.updated_at, r.id), reverse=True)
    return result


@projections_router.get("/projections/{projection_id}/points", response_model=ProjectionPointsDTO)
def get_projection_points(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    projection_id: str,
) -> ProjectionPointsDTO:
    """Coordinates + source metadata for the whole cloud (one round-trip).

    Points of fragments deleted since the compute are dropped and counted
    (`dropped_orphans`) — the map never shows ghosts (TZ §9.3).
    """
    with ctx.session_factory() as session:
        row = session.get(ProjectionRunRow, projection_id)
        if row is None:
            raise ApiError(
                404,
                "projection_not_found",
                f"Projection '{projection_id}' does not exist in this project.",
                "Build a projection first (SPACE control panel).",
            )
    cache = ProjectionCache.load(ctx.project_dir / row.npz_relpath)
    if cache is None:
        raise ApiError(
            409,
            "projection_cache_unavailable",
            f"Coordinate cache of projection '{projection_id}' is missing or damaged.",
            "Recompute the projection; the original vectors are not affected.",
        )

    current = current_embedding_signature(ctx, row.embedding_run_id)
    stale = current is None or current != row.source_signature

    meta: dict[str, tuple[FragmentRow, str]] = {}
    with ctx.session_factory() as session:
        for start in range(0, len(cache.ids), _META_CHUNK):
            chunk = cache.ids[start : start + _META_CHUNK]
            rows = session.execute(
                select(FragmentRow, FileRow.rel_path)
                .join(FileRow, FileRow.id == FragmentRow.file_id)
                .where(FragmentRow.id.in_(chunk))
            ).all()
            for frag, rel_path in rows:
                meta[frag.id] = (frag, rel_path)

    points: list[ProjectionPointDTO] = []
    dropped = 0
    for i, fragment_id in enumerate(cache.ids):
        entry = meta.get(fragment_id)
        if entry is None:
            dropped += 1
            continue
        frag, rel_path = entry
        points.append(
            ProjectionPointDTO(
                fragment_id=fragment_id,
                file_id=frag.file_id,
                rel_path=rel_path,
                kind=frag.kind,
                name=frag.name,
                symbol_path=frag.symbol_path,
                start_line=frag.start_line,
                end_line=frag.end_line,
                coords=[round(float(c), 6) for c in cache.coords[i]],
            )
        )

    return ProjectionPointsDTO(
        projection_id=row.id,
        method=row.method,
        method_display_name=_method_display_name(row.method),
        n_components=row.n_components,
        axis_labels=_parse_json(row.axis_labels_json, []),  # type: ignore[arg-type]
        axis_info=_parse_json(row.axis_info_json, None),  # type: ignore[arg-type]
        stale=stale,
        count=len(points),
        dropped_orphans=dropped,
        points=points,
    )


# ---------------------------------------------------------------------------
# Projection deletion (inventory hygiene: runs accumulate fast)
# ---------------------------------------------------------------------------


@projections_router.delete("/projections")
def delete_all_projections(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    confirm: bool = False,
) -> dict[str, int]:
    """Delete EVERY projection run of the project (rows + coordinate caches).

    Requires explicit `confirm=true` (TZ §12: destructive actions need
    confirmation). Embedding vectors, presets and the corpus are untouched.
    """
    if not confirm:
        raise ApiError(
            400,
            "confirmation_required",
            "Deleting all projections requires explicit confirmation.",
            "Repeat the request with ?confirm=true (the UI asks before sending it).",
        )
    reject_if_active_job(ctx, ("projection",), "projection_job_active")
    with ctx.session_factory() as session:
        rows = session.execute(select(ProjectionRunRow)).scalars().all()
        count = len(rows)
        for row in rows:
            session.delete(row)
        session.commit()
    projections_dir = ctx.project_dir / "cache" / "projections"
    if projections_dir.is_dir():
        for npz in projections_dir.glob("*.npz"):
            npz.unlink(missing_ok=True)
    return {"deleted": count}


@projections_router.delete("/projections/{projection_id}")
def delete_projection(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    projection_id: str,
) -> dict[str, str]:
    """Delete one projection run: inventory row + its .npz coordinate cache."""
    reject_if_active_job(ctx, ("projection",), "projection_job_active")
    with ctx.session_factory() as session:
        row = session.get(ProjectionRunRow, projection_id)
        if row is None:
            raise ApiError(
                404,
                "projection_not_found",
                f"Projection '{projection_id}' does not exist in this project.",
            )
        npz_relpath = row.npz_relpath
        session.delete(row)
        session.commit()
    (ctx.project_dir / npz_relpath).unlink(missing_ok=True)
    return {"deleted": projection_id}


# ---------------------------------------------------------------------------
# Projection presets (named form states — research workflow)
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@projections_router.get("/projection-presets", response_model=list[ProjectionPresetDTO])
def list_presets(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[ProjectionPresetDTO]:
    with ctx.session_factory() as session:
        rows = (
            session.execute(select(ProjectionPresetRow).order_by(ProjectionPresetRow.name))
            .scalars()
            .all()
        )
    return [
        ProjectionPresetDTO(
            id=row.id,
            name=row.name,
            method=row.method,
            method_display_name=_method_display_name(row.method),
            params=_parse_json(row.params_json, {}),  # type: ignore[arg-type]
            seed=row.seed,
            created_at=row.created_at,
        )
        for row in rows
    ]


@projections_router.post("/projection-presets", response_model=ProjectionPresetDTO, status_code=201)
def create_preset(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: CreatePresetRequest,
) -> ProjectionPresetDTO:
    """Save the current form (method + params + seed) under a name.

    Parameters are validated exactly like a compute request; axis ranges are
    checked at compute time (a preset is not bound to one embedding run).
    """
    method = get_method(payload.method)
    if method is None:
        raise ApiError(
            404,
            "unknown_projection_method",
            f"Projection method '{payload.method}' is not in the catalog.",
            "See GET /api/projections/methods for available methods.",
        )
    name = payload.name.strip()
    if not name:
        raise ApiError(400, "invalid_preset_name", "Preset name must not be empty.")
    try:
        normalized = method.validate_params(payload.params)
    except ProjectionParamsError as exc:
        raise ApiError(400, "invalid_projection_params", str(exc)) from None

    row = ProjectionPresetRow(
        id=uuid.uuid4().hex[:12],
        name=name,
        method=method.method_id,
        params_json=json.dumps(normalized, sort_keys=True),
        seed=payload.seed,
        created_at=_utc_now(),
    )
    with ctx.session_factory() as session:
        session.add(row)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise ApiError(
                409,
                "preset_name_taken",
                f"A preset named '{name}' already exists in this project.",
                "Choose another name or delete the existing preset first.",
            ) from None
    return ProjectionPresetDTO(
        id=row.id,
        name=row.name,
        method=row.method,
        method_display_name=_method_display_name(row.method),
        params=normalized,  # type: ignore[arg-type]
        seed=row.seed,
        created_at=row.created_at,
    )


@projections_router.delete("/projection-presets/{preset_id}")
def delete_preset(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    preset_id: str,
) -> dict[str, str]:
    with ctx.session_factory() as session:
        row = session.get(ProjectionPresetRow, preset_id)
        if row is None:
            raise ApiError(404, "preset_not_found", f"Preset '{preset_id}' does not exist.")
        session.delete(row)
        session.commit()
    return {"deleted": preset_id}
