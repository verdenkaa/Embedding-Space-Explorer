"""Research workspace endpoints: tree, text file CRUD, open-folder.

All paths are RELATIVE to the project's workspace directory and validated
server-side (app.workspace.store.resolve_in_workspace). The browser never
sends or receives authority to touch files outside that root. Document
exports and notebook execution build on this module (routes_exports_doc,
routes_notebooks) but the file model lives here.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.schemas import (
    OpenFolderRequest,
    OpenFolderResponse,
    WorkspaceCreateRequest,
    WorkspaceEntryDTO,
    WorkspaceFileContent,
    WorkspaceRenameRequest,
    WorkspaceSaveRequest,
    WorkspaceTreeResponse,
)
from app.storage.projects_store import ProjectContext
from app.workspace import store as ws

router = APIRouter(prefix="/api/projects/{project_id}/workspace", tags=["workspace"])


def _entry_dto(entry: ws.WorkspaceEntry) -> WorkspaceEntryDTO:
    return WorkspaceEntryDTO(
        path=entry.path,
        name=entry.name,
        kind=entry.kind,
        size=entry.size,
        mtime=entry.mtime,
    )


def _translate(exc: ws.WorkspaceError, action: str) -> ApiError:
    """Map workspace errors to structured API errors with actionable hints."""
    if isinstance(exc, ws.WorkspacePathError):
        return ApiError(
            400,
            "workspace_invalid_path",
            str(exc),
            "Путь должен быть относительным и находиться внутри workspace проекта.",
        )
    if isinstance(exc, ws.WorkspaceNotFound):
        return ApiError(
            404,
            "workspace_not_found",
            f"Файл не найден: {exc}",
            "Обновите дерево файлов — возможно, файл переименован или удалён.",
        )
    if isinstance(exc, ws.WorkspaceExists):
        return ApiError(409, "workspace_exists", f"Путь уже существует: {exc}")
    if isinstance(exc, ws.WorkspaceBinaryError):
        return ApiError(
            415,
            "workspace_binary_file",
            f"Файл не является текстом UTF-8: {exc}",
            "Текстовый редактор работает только с UTF-8 файлами.",
        )
    if isinstance(exc, ws.WorkspaceTooLarge):
        return ApiError(
            413,
            "workspace_file_too_large",
            f"Файл больше {exc.limit // (1024 * 1024)} МБ: {exc.path}",
        )
    return ApiError(500, "workspace_error", f"{action}: {exc}")


@router.get("/tree", response_model=WorkspaceTreeResponse)
def get_tree(ctx: Annotated[ProjectContext, Depends(get_project)]) -> WorkspaceTreeResponse:
    """Full workspace listing; creates the skeleton on first use."""
    root = ws.ensure_workspace(ctx)
    entries, truncated = ws.list_tree(ctx)
    return WorkspaceTreeResponse(
        entries=[_entry_dto(e) for e in entries],
        truncated=truncated,
        root=str(root),
    )


@router.get("/file", response_model=WorkspaceFileContent)
def get_file(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    path: Annotated[str, Query(min_length=1, max_length=2048)],
) -> WorkspaceFileContent:
    try:
        content, mtime, size = ws.read_text(ctx, path)
    except ws.WorkspaceError as exc:
        raise _translate(exc, "read") from None
    return WorkspaceFileContent(path=path, content=content, size=size, mtime=mtime)


@router.get("/raw")
def get_raw_file(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    path: Annotated[str, Query(min_length=1, max_length=2048)],
) -> FileResponse:
    """Serve a workspace file as BINARY (images referenced by notes, PDFs).

    The markdown note editor rewrites relative image sources to this route so
    plots saved by notebooks (results/*.png) render inside the application.
    Path safety is identical to the text endpoints (resolve_in_workspace).

    Hardening: text/html is downgraded to text/plain (a workspace file must
    never execute scripts on the application's origin) and nosniff is set.
    """
    try:
        file_path, _size, media_type = ws.read_binary_meta(ctx, path)
    except ws.WorkspaceError as exc:
        raise _translate(exc, "raw") from None
    if media_type in ("text/html", "application/xhtml+xml"):
        media_type = "text/plain"
    return FileResponse(
        file_path,
        media_type=media_type,
        filename=file_path.name,
        content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.post("/file", response_model=WorkspaceEntryDTO, status_code=201)
def create_file(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: WorkspaceCreateRequest,
) -> WorkspaceEntryDTO:
    try:
        entry = ws.create_path(
            ctx, payload.path, content=payload.content, is_dir=payload.kind == "dir"
        )
    except ws.WorkspaceError as exc:
        raise _translate(exc, "create") from None
    return _entry_dto(entry)


@router.put("/file", response_model=WorkspaceFileContent)
def save_file(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: WorkspaceSaveRequest,
) -> WorkspaceFileContent:
    try:
        mtime = ws.write_text(
            ctx, payload.path, payload.content, base_mtime=payload.base_mtime, force=payload.force
        )
    except ws.WorkspaceConflict as conflict:
        raise ApiError(
            409,
            "workspace_conflict",
            f"Файл изменён на диске после открытия (mtime {conflict.disk_mtime:.0f}).",
            "Перезагрузите файл или сохраните принудительно (force), если ваша версия новее.",
        ) from None
    except ws.WorkspaceError as exc:
        raise _translate(exc, "save") from None
    size = len(payload.content.encode("utf-8"))
    return WorkspaceFileContent(path=payload.path, content=payload.content, size=size, mtime=mtime)


@router.post("/rename", response_model=WorkspaceEntryDTO)
def rename_file(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: WorkspaceRenameRequest,
) -> WorkspaceEntryDTO:
    try:
        entry = ws.rename_path(ctx, payload.from_path, payload.to_path)
    except ws.WorkspaceError as exc:
        raise _translate(exc, "rename") from None
    return _entry_dto(entry)


@router.delete("/file")
def delete_file(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    path: Annotated[str, Query(min_length=1, max_length=2048)],
    confirm: Annotated[bool, Query()] = False,
) -> dict[str, str]:
    try:
        ws.delete_path(ctx, path, confirm=confirm)
    except ws.WorkspaceError as exc:
        raise _translate(exc, "delete") from None
    return {"deleted": path}


@router.post("/open-folder", response_model=OpenFolderResponse)
def open_folder(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: OpenFolderRequest,
) -> OpenFolderResponse:
    """Open the workspace (or one FIXED subdir) in the OS file manager.

    The client cannot pass an arbitrary path: only "" or a known subdir name,
    so the launched system command is fully determined server-side (TZ §3.3).
    """
    sub = payload.sub.strip().strip("/")
    if sub and sub not in ws.WORKSPACE_SUBDIRS:
        raise ApiError(
            400,
            "workspace_invalid_path",
            f"Неизвестный каталог рабочего пространства: {sub!r}",
            f"Допустимые значения: {', '.join(ws.WORKSPACE_SUBDIRS)} или пусто (корень).",
        )
    root = ws.ensure_workspace(ctx)
    target = root / sub if sub else root
    opened, error = ws.open_in_file_manager(target)
    return OpenFolderResponse(opened=opened, path=str(target), error=error)
