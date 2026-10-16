"""Structural relation endpoints (TZ §7.2, §7.3).

Provenance is never mixed: every relation keeps origin=extracted|imported|
manual, and the semantic-neighbor layer (routes_neighbors) stays a separate
API — the UI shows structural links and semantic similarity differently.

- GET  /relations            — filtered browser (fragment/file/kind/origin)
- POST /relations            — manual relation between two fragments
- POST /relations/import     — ese-relations/v1 corpus import with an honest
                               per-row report (unresolved rows are listed)
- POST /relations/extract    — background re-extraction (imports/belongs_to)
- DELETE /relations/{id}     — remove one relation (any origin; re-extraction
                               brings extracted ones back)
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_job_manager, get_project
from app.api.errors import ApiError
from app.api.routes_embeddings import reject_if_active_job
from app.api.schemas import (
    CreateRelationRequest,
    ImportRelationsResponse,
    JobInfo,
    RelationDTO,
    RelationEndpointDTO,
    RelationsResponse,
    UnresolvedRelationDTO,
)
from app.api.serialization import job_info_from_row
from app.jobs.manager import JobManager
from app.jobs.relations import make_relations_runner
from app.relation_providers.importer import (
    FORMAT_ID,
    ImportFormatError,
    ImportRelation,
    parse_import_payload,
)
from app.storage.models import FileRow, FragmentRow, JobRow, RelationRow
from app.storage.projects_store import ProjectContext

router = APIRouter(prefix="/api/projects/{project_id}", tags=["relations"])


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Endpoint resolution helpers
# ---------------------------------------------------------------------------


def _load_endpoint_maps(
    session: Session, rows: list[RelationRow]
) -> tuple[dict[str, FragmentRow], dict[str, FileRow]]:
    frag_ids = {r.source_fragment_id for r in rows if r.source_fragment_id}
    frag_ids |= {r.target_fragment_id for r in rows if r.target_fragment_id}
    file_ids = {r.source_file_id for r in rows if r.source_file_id}
    file_ids |= {r.target_file_id for r in rows if r.target_file_id}
    frags: dict[str, FragmentRow] = {}
    files: dict[str, FileRow] = {}
    if frag_ids:
        for frag in session.execute(
            select(FragmentRow).where(FragmentRow.id.in_(frag_ids))
        ).scalars():
            frags[frag.id] = frag
    if file_ids:
        for file_row in session.execute(select(FileRow).where(FileRow.id.in_(file_ids))).scalars():
            files[file_row.id] = file_row
    return frags, files


def _endpoint_dto(
    file_id: str | None,
    fragment_id: str | None,
    frags: dict[str, FragmentRow],
    files: dict[str, FileRow],
) -> RelationEndpointDTO | None:
    frag = frags.get(fragment_id) if fragment_id else None
    file_row = files.get(file_id) if file_id else None
    if frag is None and file_row is None:
        return None
    rel_path = file_row.rel_path if file_row else None
    if rel_path is None and frag is not None:
        frag_file = files.get(frag.file_id)
        rel_path = frag_file.rel_path if frag_file is not None else None
    return RelationEndpointDTO(
        file_id=file_row.id if file_row else (frag.file_id if frag else None),
        fragment_id=frag.id if frag else None,
        rel_path=rel_path,
        name=frag.name if frag else None,
        symbol_path=frag.symbol_path if frag else None,
        start_line=frag.start_line if frag else None,
        end_line=frag.end_line if frag else None,
    )


def _to_dto(
    row: RelationRow, frags: dict[str, FragmentRow], files: dict[str, FileRow]
) -> RelationDTO | None:
    source = _endpoint_dto(row.source_file_id, row.source_fragment_id, frags, files)
    target = _endpoint_dto(row.target_file_id, row.target_fragment_id, frags, files)
    if source is None or target is None:
        return None  # endpoints vanished; filtered honestly, never half-shown
    return RelationDTO(
        id=row.id,
        kind=row.kind,
        origin=row.origin,
        confidence=row.confidence,
        detail=row.detail,
        created_at=row.created_at,
        source=source,
        target=target,
    )


# ---------------------------------------------------------------------------
# Browser
# ---------------------------------------------------------------------------


@router.get("/relations", response_model=RelationsResponse)
def list_relations(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    fragment_id: Annotated[str | None, Query(max_length=16)] = None,
    file_id: Annotated[str | None, Query(max_length=32)] = None,
    kind: Annotated[str | None, Query(max_length=32)] = None,
    origin: Annotated[str | None, Query(max_length=16)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RelationsResponse:
    with ctx.session_factory() as session:
        stmt = select(RelationRow)
        if fragment_id:
            stmt = stmt.where(
                or_(
                    RelationRow.source_fragment_id == fragment_id,
                    RelationRow.target_fragment_id == fragment_id,
                )
            )
        if file_id:
            stmt = stmt.where(
                or_(RelationRow.source_file_id == file_id, RelationRow.target_file_id == file_id)
            )
        if kind:
            stmt = stmt.where(RelationRow.kind == kind)
        if origin:
            stmt = stmt.where(RelationRow.origin == origin)
        total = session.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
        rows = list(
            session.execute(
                stmt.order_by(RelationRow.kind, RelationRow.id).limit(limit).offset(offset)
            )
            .scalars()
            .all()
        )

        # global counts power the filter UI (not the filtered subset)
        kind_counts = dict(
            session.execute(select(RelationRow.kind, func.count()).group_by(RelationRow.kind)).all()
        )
        origin_counts = dict(
            session.execute(
                select(RelationRow.origin, func.count()).group_by(RelationRow.origin)
            ).all()
        )
        frags, files = _load_endpoint_maps(session, rows)
        # fragment endpoints may live in files not referenced as file endpoints
        extra_file_ids = {f.file_id for f in frags.values()} - set(files)
        if extra_file_ids:
            for file_row in session.execute(
                select(FileRow).where(FileRow.id.in_(extra_file_ids))
            ).scalars():
                files[file_row.id] = file_row
        items = [dto for dto in (_to_dto(row, frags, files) for row in rows) if dto is not None]

    return RelationsResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        counts_by_kind={str(k): int(v) for k, v in kind_counts.items()},
        counts_by_origin={str(k): int(v) for k, v in origin_counts.items()},
    )


# ---------------------------------------------------------------------------
# Manual relations
# ---------------------------------------------------------------------------


@router.post("/relations", response_model=RelationDTO, status_code=201)
def create_manual_relation(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: CreateRelationRequest,
) -> RelationDTO:
    if payload.source_fragment_id == payload.target_fragment_id:
        raise ApiError(400, "invalid_relation", "A relation must connect two different fragments.")
    kind = payload.kind.strip()
    if not kind:
        raise ApiError(400, "invalid_relation", "Relation kind must not be empty.")
    with ctx.session_factory() as session:
        source = session.get(FragmentRow, payload.source_fragment_id)
        target = session.get(FragmentRow, payload.target_fragment_id)
        if source is None or target is None:
            missing = payload.source_fragment_id if source is None else payload.target_fragment_id
            raise ApiError(404, "fragment_not_found", f"Fragment '{missing}' does not exist.")
        row = RelationRow(
            id=uuid.uuid4().hex[:12],
            source_file_id=source.file_id,
            source_fragment_id=source.id,
            target_file_id=target.file_id,
            target_fragment_id=target.id,
            kind=kind,
            origin="manual",
            confidence=None,
            detail=payload.detail,
            created_at=_utc_now(),
        )
        session.add(row)
        session.commit()
        frags, files = _load_endpoint_maps(session, [row])
        dto = _to_dto(row, frags, files)
    if dto is None:  # pragma: no cover - endpoints were just validated
        raise ApiError(500, "relation_build_failed", "Could not resolve relation endpoints.")
    return dto


@router.delete("/relations/{relation_id}")
def delete_relation(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    relation_id: str,
) -> dict[str, str]:
    with ctx.session_factory() as session:
        row = session.get(RelationRow, relation_id)
        if row is None:
            raise ApiError(404, "relation_not_found", f"Relation '{relation_id}' does not exist.")
        session.delete(row)
        session.commit()
    return {"deleted": relation_id}


# ---------------------------------------------------------------------------
# Import (TZ §7.3)
# ---------------------------------------------------------------------------


@router.post("/relations/import", response_model=ImportRelationsResponse)
def import_relations(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: dict[str, Any],
) -> ImportRelationsResponse:
    """Import an `ese-relations/v1` corpus; report every unresolved row."""
    try:
        parsed: list[ImportRelation] = parse_import_payload(payload)
    except ImportFormatError as exc:
        raise ApiError(
            400,
            "invalid_relations_format",
            str(exc),
            f"Expected format '{FORMAT_ID}'; see docs/data-model.md §6.8.",
        ) from None

    with ctx.session_factory() as session:
        files = {
            f.rel_path.replace("\\", "/"): f.id for f in session.execute(select(FileRow)).scalars()
        }
        fragments = list(session.execute(select(FragmentRow)).scalars().all())
        frags_by_file: dict[str, list[FragmentRow]] = {}
        frags_by_symbol: dict[tuple[str, str], FragmentRow] = {}
        for frag in fragments:
            frags_by_file.setdefault(frag.file_id, []).append(frag)
            frags_by_symbol[(frag.file_id, frag.symbol_path)] = frag
        existing = {
            (r.kind, r.source_file_id, r.source_fragment_id, r.target_file_id, r.target_fragment_id)
            for r in session.execute(select(RelationRow)).scalars()
        }

        imported = 0
        duplicates = 0
        unresolved: list[UnresolvedRelationDTO] = []
        now = _utc_now()

        def resolve(
            side: Any, index: int, name: str, kind: str
        ) -> tuple[str | None, str | None] | None:
            """→ (file_id, fragment_id) or None (reason recorded)."""
            file_id = files.get(side.path)
            if file_id is None:
                unresolved.append(
                    UnresolvedRelationDTO(
                        index=index,
                        kind=kind,
                        reason=f"{name}: file '{side.path}' is not in the project index",
                    )
                )
                return None
            if side.symbol_path is not None:
                frag = frags_by_symbol.get((file_id, side.symbol_path))
                if frag is None:
                    unresolved.append(
                        UnresolvedRelationDTO(
                            index=index,
                            kind=kind,
                            reason=(
                                f"{name}: no fragment with symbol_path '{side.symbol_path}' "
                                f"in '{side.path}'"
                            ),
                        )
                    )
                    return None
                return file_id, frag.id
            if side.start_line is not None:
                best: FragmentRow | None = None
                for frag in frags_by_file.get(file_id, []):
                    encloses = frag.start_line <= side.start_line <= frag.end_line
                    smaller = best is None or (frag.end_line - frag.start_line) < (
                        best.end_line - best.start_line
                    )
                    if encloses and smaller:
                        best = frag
                if best is None:
                    unresolved.append(
                        UnresolvedRelationDTO(
                            index=index,
                            kind=kind,
                            reason=(
                                f"{name}: no fragment encloses line {side.start_line} "
                                f"of '{side.path}'"
                            ),
                        )
                    )
                return None if best is None else (file_id, best.id)
            return file_id, None  # file-level endpoint (valid)

        for index, rel in enumerate(parsed):
            source = resolve(rel.source, index, "source", rel.kind)
            if source is None:
                continue
            target = resolve(rel.target, index, "target", rel.kind)
            if target is None:
                continue
            key = (rel.kind, source[0], source[1], target[0], target[1])
            if key in existing:
                duplicates += 1
                continue
            existing.add(key)
            session.add(
                RelationRow(
                    id=uuid.uuid4().hex[:12],
                    source_file_id=source[0],
                    source_fragment_id=source[1],
                    target_file_id=target[0],
                    target_fragment_id=target[1],
                    kind=rel.kind,
                    origin="imported",
                    confidence=rel.confidence,
                    detail=rel.detail,
                    created_at=now,
                )
            )
            imported += 1
        session.commit()

    return ImportRelationsResponse(imported=imported, duplicates=duplicates, unresolved=unresolved)


# ---------------------------------------------------------------------------
# Extraction job
# ---------------------------------------------------------------------------


@router.post("/relations/extract", response_model=JobInfo, status_code=202)
def extract_relations_job(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    manager: Annotated[JobManager, Depends(get_job_manager)],
    response: Response,
) -> JobInfo:
    """Re-extract surface relations (imports, belongs_to) from the corpus."""
    reject_if_active_job(ctx, ("index", "relations"), "active_job_conflict")
    job_id = manager.submit(ctx, "relations", make_relations_runner(), params={})
    response.status_code = 202
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)
