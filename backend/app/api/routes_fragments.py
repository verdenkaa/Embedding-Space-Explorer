"""Fragment endpoints: search and detail (fragment → text → file lines)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.routes_files import resolve_readable_path
from app.api.schemas import FragmentDetail, FragmentSearchItem, FragmentSearchResponse
from app.source_registry.changes import read_text_safely
from app.storage.models import FileRow, FragmentRow
from app.storage.projects_store import ProjectContext

router = APIRouter(prefix="/api/projects/{project_id}", tags=["fragments"])


@router.get("/fragments", response_model=FragmentSearchResponse)
def search_fragments(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    q: Annotated[str, Query(max_length=300)] = "",
    kind: Annotated[str | None, Query(max_length=32)] = None,
    file_id: Annotated[str | None, Query(max_length=32)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> FragmentSearchResponse:
    with ctx.session_factory() as session:
        stmt = select(FragmentRow, FileRow.rel_path).join(
            FileRow, FileRow.id == FragmentRow.file_id
        )
        if file_id:
            stmt = stmt.where(FragmentRow.file_id == file_id)
        if kind:
            stmt = stmt.where(FragmentRow.kind == kind)
        if q.strip():
            like = f"%{q.strip().lower()}%"
            stmt = stmt.where(
                or_(
                    func.lower(FragmentRow.symbol_path).like(like),
                    func.lower(func.coalesce(FragmentRow.name, "")).like(like),
                    func.lower(FileRow.rel_path).like(like),
                )
            )
        total = session.execute(select(func.count()).select_from(stmt.subquery())).scalar_one()
        rows = session.execute(
            stmt.order_by(FragmentRow.start_line).limit(limit).offset(offset)
        ).all()
        items = [
            FragmentSearchItem(
                id=f.id,
                file_id=f.file_id,
                kind=f.kind,
                name=f.name,
                symbol_path=f.symbol_path,
                parent_symbol_path=f.parent_symbol_path,
                start_line=f.start_line,
                end_line=f.end_line,
                method=f.method,
                language=f.language,
                ordinal=f.ordinal,
                rel_path=rel_path,
            )
            for f, rel_path in rows
        ]
    return FragmentSearchResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/fragments/{fragment_id}", response_model=FragmentDetail)
def get_fragment(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    fragment_id: str,
) -> FragmentDetail:
    with ctx.session_factory() as session:
        row = session.get(FragmentRow, fragment_id)
        if row is None:
            raise ApiError(
                404, "fragment_not_found", f"Fragment '{fragment_id}' is not in this project."
            )
        file_row = session.get(FileRow, row.file_id)
        if file_row is None:  # pragma: no cover - FK integrity
            raise ApiError(404, "file_not_found", "Parent file of the fragment is missing.")
        path = resolve_readable_path(ctx, file_row.abs_path, file_row.rel_path)
        detail = FragmentDetail(
            id=row.id,
            file_id=row.file_id,
            kind=row.kind,
            name=row.name,
            symbol_path=row.symbol_path,
            parent_symbol_path=row.parent_symbol_path,
            start_line=row.start_line,
            end_line=row.end_line,
            method=row.method,
            language=row.language,
            ordinal=row.ordinal,
            rel_path=file_row.rel_path,
            start_offset=row.start_offset,
            end_offset=row.end_offset,
            content_hash=row.content_hash,
            text="",  # filled below from the live file
        )

    # Text is re-read from source so the viewer always shows the CURRENT
    # file state; if it drifted from content_hash, the changes check will
    # report the file as modified (honest staleness, no silent mixing).
    text, error = read_text_safely(str(path))
    if text is None:
        detail.text = f"<file unavailable: {error}>"
    else:
        lines = text.split("\n")
        detail.text = "\n".join(lines[detail.start_line - 1 : detail.end_line])
    return detail
