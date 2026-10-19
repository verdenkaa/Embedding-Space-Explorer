"""File endpoints: listing, detail with fragments, safe content read, locate."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.schemas import (
    FileContentResponse,
    FileDetail,
    FileSummary,
    FragmentMeta,
    LocateRequest,
    LocateResponse,
)
from app.source_registry.changes import read_text_safely
from app.storage.models import FileRow, FragmentRow
from app.storage.projects_store import ProjectContext, resolve_safe_under_roots

router = APIRouter(prefix="/api/projects/{project_id}", tags=["files"])

#: Hard guard independent of project options; indexed files are <= max_file_size anyway.
_MAX_CONTENT_BYTES = 8 * 1024 * 1024


def _file_summary(row: FileRow, fragment_count: int = 0) -> FileSummary:
    return FileSummary(
        id=row.id,
        root=row.root,
        rel_path=row.rel_path,
        size=row.size,
        mtime=row.mtime,
        language=row.language,
        status=row.status,  # type: ignore[arg-type]
        skip_reason=row.skip_reason,
        detail=row.detail,
        indexed_at=row.indexed_at,
        fragment_count=fragment_count,
    )


def _fragment_meta(row: FragmentRow) -> FragmentMeta:
    return FragmentMeta(
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
    )


def get_file_row(session: Session, project: ProjectContext, file_id: str) -> FileRow:
    row = session.get(FileRow, file_id)
    if row is None:
        raise ApiError(404, "file_not_found", f"File '{file_id}' is not in this project.")
    return row


def resolve_readable_path(ctx: ProjectContext, abs_path: str, rel_path: str) -> Path:
    """Verify a stored file path is still readable inside the project roots.

    Never trusts the DB blindly: re-resolves and re-checks containment on
    every read. Symlinks outside roots are only honored when the
    project explicitly allowed them at scan time.
    """
    if ctx.manifest.split_options.allow_symlinks_outside_root:
        path = Path(abs_path)
    else:
        resolved = resolve_safe_under_roots(abs_path, ctx.manifest.roots)
        if resolved is None:
            raise ApiError(
                403,
                "path_escape",
                f"Stored path for '{rel_path}' is outside the project roots.",
                "Roots may have moved; re-check changes and re-index.",
            )
        path = resolved
    if not path.is_file():
        raise ApiError(
            409,
            "file_unavailable",
            f"File '{rel_path}' no longer exists at its indexed location.",
            "Run 'check changes' and re-index the project.",
        )
    return path


@router.get("/files", response_model=list[FileSummary])
def list_files(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    status: Annotated[str | None, Query(pattern="^(indexed|error|skipped)$")] = None,
) -> list[FileSummary]:
    with ctx.session_factory() as session:
        counts = dict(
            session.execute(
                select(FragmentRow.file_id, func.count(FragmentRow.id)).group_by(
                    FragmentRow.file_id
                )
            ).all()
        )
        stmt = select(FileRow)
        if status is not None:
            stmt = stmt.where(FileRow.status == status)
        rows = session.execute(stmt.order_by(FileRow.rel_path)).scalars().all()
        return [_file_summary(r, counts.get(r.id, 0)) for r in rows]


@router.get("/files/{file_id}", response_model=FileDetail)
def get_file(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    file_id: str,
) -> FileDetail:
    with ctx.session_factory() as session:
        row = get_file_row(session, ctx, file_id)
        fragments = (
            session.execute(
                select(FragmentRow)
                .where(FragmentRow.file_id == file_id)
                .order_by(FragmentRow.start_line, FragmentRow.end_line)
            )
            .scalars()
            .all()
        )
        return FileDetail(
            file=_file_summary(row, len(fragments)),
            fragments=[_fragment_meta(f) for f in fragments],
        )


@router.get("/files/{file_id}/content", response_model=FileContentResponse)
def get_file_content(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    file_id: str,
) -> FileContentResponse:
    with ctx.session_factory() as session:
        row = get_file_row(session, ctx, file_id)
    path = resolve_readable_path(ctx, row.abs_path, row.rel_path)
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ApiError(
            409, "file_unavailable", f"Cannot stat file: {exc.__class__.__name__}"
        ) from None
    if size > _MAX_CONTENT_BYTES:
        raise ApiError(
            413,
            "file_too_large",
            f"File is {size} bytes; the viewer limit is {_MAX_CONTENT_BYTES}.",
        )
    text, error = read_text_safely(str(path))
    if text is None:
        raise ApiError(409, "file_unavailable", error or "Cannot read file.")
    return FileContentResponse(
        file_id=row.id,
        rel_path=row.rel_path,
        language=row.language,
        content=text,
        total_lines=text.count("\n") + (0 if text.endswith("\n") else 1),
    )


@router.post("/files/{file_id}/locate", response_model=LocateResponse)
def locate_fragments(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    file_id: str,
    payload: LocateRequest,
) -> LocateResponse:
    """Reverse tracing: line selection → all overlapping fragments."""
    with ctx.session_factory() as session:
        get_file_row(session, ctx, file_id)
        rows = (
            session.execute(
                select(FragmentRow)
                .where(
                    FragmentRow.file_id == file_id,
                    FragmentRow.start_line <= payload.end_line,
                    FragmentRow.end_line >= payload.start_line,
                )
                .order_by(FragmentRow.start_line, FragmentRow.end_line)
            )
            .scalars()
            .all()
        )
    fragments = [_fragment_meta(r) for r in rows]
    # Most specific first: smaller spans, then deeper nesting.
    fragments.sort(key=lambda f: (f.end_line - f.start_line, f.start_line))
    ambiguous = len(fragments) > 1
    note = None
    if ambiguous:
        note = (
            f"Выбор пересекает {len(fragments)} фрагментов; показаны от наиболее "
            "специфичного к более общим. Вложенность видна по symbol_path."
        )
    return LocateResponse(fragments=fragments, ambiguous=ambiguous, note=note)
