"""Notebook endpoints: .ipynb CRUD with nbformat validation + kernel sessions.

Files live in the project workspace (app.workspace validates every path);
execution goes through KernelSessionManager — one persistent ipykernel per
notebook, bound to (project, resolved path). The frontend polls executions
(same interaction model as jobs elsewhere in the app; no WebSocket).
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.routes_workspace import _translate as translate_workspace_error
from app.api.schemas import (
    KernelSessionDTO,
    KernelSessionRequest,
    NotebookContentResponse,
    NotebookCreateRequest,
    NotebookExecuteRequest,
    NotebookExecuteResponse,
    NotebookExecutionDTO,
    NotebookListItem,
    NotebookSaveRequest,
    NotebookSaveResponse,
)
from app.notebooks import format as nbfmt
from app.notebooks.kernel_manager import (
    ExecutionInProgressError,
    KernelLimitError,
    KernelNotReadyError,
    KernelSession,
    KernelSessionManager,
)
from app.storage.projects_store import ProjectContext
from app.workspace import store as ws

router = APIRouter(prefix="/api/projects/{project_id}/notebooks", tags=["notebooks"])


def get_kernel_manager(request: Request) -> KernelSessionManager:
    manager: KernelSessionManager = request.app.state.kernel_manager
    return manager


def backend_root() -> Path:
    """Directory that contains the `app` and `ese` packages (kernel PYTHONPATH)."""
    import app as app_pkg

    return Path(app_pkg.__file__ or ".").resolve().parents[1]


def _session_dto(session: KernelSession) -> KernelSessionDTO:
    data = session.describe()
    return KernelSessionDTO(**data)


def _require_ipynb(ctx: ProjectContext, rel_path: str) -> Path:
    """Resolve a notebook path inside the workspace; enforce the .ipynb name."""
    try:
        path = ws.resolve_in_workspace(ctx, rel_path)
    except ws.WorkspaceError as exc:
        raise translate_workspace_error(exc, "resolve") from None
    if path.suffix.lower() != ".ipynb":
        raise ApiError(
            400,
            "not_a_notebook",
            f"Ожидался файл .ipynb, получено: {rel_path}",
            "Блокноты хранятся в каталоге notebooks/ рабочего пространства проекта.",
        )
    return path


def _ese_project_id(notebook: dict[str, Any]) -> str | None:
    ese = notebook.get("metadata", {}).get("ese")
    if isinstance(ese, dict) and isinstance(ese.get("project_id"), str):
        return str(ese["project_id"])
    return None


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


@router.get("", response_model=list[NotebookListItem])
def list_notebooks(ctx: Annotated[ProjectContext, Depends(get_project)]) -> list[NotebookListItem]:
    """All .ipynb files of the project workspace (any nesting)."""
    ws.ensure_workspace(ctx)
    entries, _ = ws.list_tree(ctx)
    return [
        NotebookListItem(path=e.path, name=e.name, size=e.size, mtime=e.mtime)
        for e in entries
        if e.kind == "file" and e.path.lower().endswith(".ipynb")
    ]


@router.post("", response_model=NotebookListItem, status_code=201)
def create_notebook(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: NotebookCreateRequest,
) -> NotebookListItem:
    """Create a new notebook bound to THIS project (metadata.ese.project_id)."""
    path = _require_ipynb(ctx, payload.path)
    content = nbfmt.serialize_notebook(nbfmt.new_notebook(ctx.id))
    try:
        entry = ws.create_path(ctx, payload.path, content=content)
    except ws.WorkspaceError as exc:
        raise translate_workspace_error(exc, "create") from None
    if not path.is_file():  # pragma: no cover - defensive
        raise ApiError(500, "workspace_error", "блокнот не был создан")
    return NotebookListItem(path=entry.path, name=entry.name, size=entry.size, mtime=entry.mtime)


@router.get("/content", response_model=NotebookContentResponse)
def get_notebook(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    path: Annotated[str, Query(min_length=1, max_length=2048)],
) -> NotebookContentResponse:
    """Parse and return a notebook; damaged files come back WITH problems."""
    abs_path = _require_ipynb(ctx, path)
    if not abs_path.is_file():
        raise ApiError(404, "workspace_not_found", f"Блокнот не найден: {path}")
    try:
        nb, problems = nbfmt.read_notebook_file(abs_path)
    except nbfmt.NotebookFormatError as exc:
        raise ApiError(
            422,
            "notebook_invalid",
            str(exc),
            "Файл не является корректным .ipynb; приложение не будет показывать его как блокнот.",
        ) from None
    except OSError as exc:
        raise ApiError(500, "workspace_error", f"не удалось прочитать блокнот: {exc}") from None
    notebook = nbfmt.notebook_to_json(nb)
    stat = abs_path.stat()
    return NotebookContentResponse(
        path=path,
        notebook=notebook,
        valid=not problems,
        problems=problems,
        mtime=stat.st_mtime,
        size=stat.st_size,
        ese_project_id=_ese_project_id(notebook),
    )


@router.put("/content", response_model=NotebookSaveResponse)
def save_notebook(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: NotebookSaveRequest,
) -> NotebookSaveResponse:
    """Validate + normalize (cell ids, nbformat 4.5) and save atomically."""
    _require_ipynb(ctx, payload.path)
    try:
        nb = nbfmt.notebook_from_json(payload.notebook)
    except nbfmt.NotebookFormatError as exc:
        raise ApiError(422, "notebook_invalid", str(exc)) from None
    problems = nbfmt.normalize(nb)
    content = nbfmt.serialize_notebook(nb)
    try:
        mtime = ws.write_text(
            ctx, payload.path, content, base_mtime=payload.base_mtime, force=payload.force
        )
    except ws.WorkspaceConflict:
        raise ApiError(
            409,
            "workspace_conflict",
            "Файл блокнота изменён на диске после открытия.",
            "Перезагрузите блокнот или сохраните принудительно (force), если ваша версия новее.",
        ) from None
    except ws.WorkspaceError as exc:
        raise translate_workspace_error(exc, "save") from None
    return NotebookSaveResponse(
        path=payload.path,
        mtime=mtime,
        size=len(content.encode("utf-8")),
        valid=not problems,
        problems=problems,
    )


# ---------------------------------------------------------------------------
# Kernel sessions
# ---------------------------------------------------------------------------


@router.post("/sessions", response_model=KernelSessionDTO, status_code=201)
def start_session(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: KernelSessionRequest,
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> KernelSessionDTO:
    abs_path = _require_ipynb(ctx, payload.path)
    if not abs_path.is_file():
        raise ApiError(404, "workspace_not_found", f"Блокнот не найден: {payload.path}")
    workspace = ws.ensure_workspace(ctx)
    try:
        session = manager.start_session(
            project_id=ctx.id,
            workspace_dir=workspace.resolve(),
            notebook_path=abs_path.resolve(),
            data_dir=ctx.data_dir,
            backend_root=backend_root(),
        )
    except KernelLimitError as exc:
        raise ApiError(503, "kernel_limit", str(exc)) from None
    return _session_dto(session)


@router.get("/sessions", response_model=list[KernelSessionDTO])
def list_sessions(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> list[KernelSessionDTO]:
    return [KernelSessionDTO(**data) for data in manager.list_for_project(ctx.id)]


def _owned_session(
    manager: KernelSessionManager, project_id: str, session_id: str
) -> KernelSession:
    session = manager.get(session_id, project_id)
    if session is None:
        # Includes sessions of OTHER projects: they simply do not exist here.
        raise ApiError(404, "session_not_found", f"Сессия ядра '{session_id}' не найдена.")
    return session


@router.get("/sessions/{session_id}", response_model=KernelSessionDTO)
def get_session(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    session_id: str,
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> KernelSessionDTO:
    return _session_dto(_owned_session(manager, ctx.id, session_id))


@router.delete("/sessions/{session_id}")
def close_session(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    session_id: str,
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> dict[str, str]:
    if not manager.close_session(session_id, ctx.id):
        raise ApiError(404, "session_not_found", f"Сессия ядра '{session_id}' не найдена.")
    return {"closed": session_id}


@router.post("/sessions/{session_id}/execute", response_model=NotebookExecuteResponse)
def execute_cell(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    session_id: str,
    payload: NotebookExecuteRequest,
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> NotebookExecuteResponse:
    session = _owned_session(manager, ctx.id, session_id)
    try:
        execution = session.execute(payload.code)
    except KernelNotReadyError as exc:
        hint = {
            "starting": "Ядро запускается — повторите запрос через секунду.",
            "restarting": "Ядро перезапускается — дождитесь статуса ready.",
            "dead": "Ядро завершилось — перезапустите его.",
            "error": exc.error or "Ядро не удалось запустить.",
        }.get(exc.state, "Дождитесь готовности ядра.")
        raise ApiError(409, "kernel_not_ready", str(exc), hint) from None
    except ExecutionInProgressError as exc:
        raise ApiError(
            409,
            "execution_in_progress",
            str(exc),
            "Дождитесь завершения текущей ячейки или остановите выполнение.",
        ) from None
    return NotebookExecuteResponse(execution_id=execution.id, status=execution.status)


@router.get("/sessions/{session_id}/executions/{execution_id}", response_model=NotebookExecutionDTO)
def get_execution(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    session_id: str,
    execution_id: str,
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> NotebookExecutionDTO:
    session = _owned_session(manager, ctx.id, session_id)
    execution = session.get_execution(execution_id)
    if execution is None:
        raise ApiError(404, "execution_not_found", f"Выполнение '{execution_id}' не найдено.")
    return NotebookExecutionDTO(**execution.to_dict())


@router.post("/sessions/{session_id}/interrupt", response_model=KernelSessionDTO)
def interrupt_session(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    session_id: str,
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> KernelSessionDTO:
    session = _owned_session(manager, ctx.id, session_id)
    session.interrupt()
    return _session_dto(session)


@router.post("/sessions/{session_id}/restart", response_model=KernelSessionDTO)
def restart_session(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    session_id: str,
    manager: Annotated[KernelSessionManager, Depends(get_kernel_manager)],
) -> KernelSessionDTO:
    session = _owned_session(manager, ctx.id, session_id)
    session.restart()
    return _session_dto(session)
