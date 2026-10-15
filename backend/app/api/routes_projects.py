"""Project lifecycle endpoints: create, list, open, delete, changes, index."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select

from app.api.deps import get_job_manager, get_project, get_project_store
from app.api.errors import ApiError
from app.api.schemas import (
    ChangesReport,
    FileChangeDTO,
    JobInfo,
    ProjectCreateRequest,
    ProjectInfo,
    ProjectStats,
    ProjectSummaryDTO,
    SkippedFileDTO,
    StalenessReport,
)
from app.api.serialization import job_info_from_row
from app.jobs.indexing import build_index_inputs, compute_staleness, run_index_job
from app.jobs.manager import JobManager
from app.storage.models import FileRow, FragmentRow, JobRow
from app.storage.projects_store import (
    ProjectContext,
    ProjectStore,
    ProjectValidationError,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _project_info(ctx: ProjectContext, with_stats: bool) -> ProjectInfo:
    stats: ProjectStats | None = None
    if with_stats:
        with ctx.session_factory() as session:
            files_indexed = session.execute(
                select(func.count(FileRow.id)).where(FileRow.status == "indexed")
            ).scalar_one()
            files_error = session.execute(
                select(func.count(FileRow.id)).where(FileRow.status == "error")
            ).scalar_one()
            fragments = session.execute(select(func.count(FragmentRow.id))).scalar_one()
            running = session.execute(
                select(JobRow.id)
                .where(JobRow.state.in_(("queued", "running")))
                .order_by(JobRow.created_at.desc())
                .limit(1)
            ).scalar_one_or_none()
        stats = ProjectStats(
            files_indexed=files_indexed,
            files_error=files_error,
            fragments=fragments,
            running_job_id=running,
        )
    m = ctx.manifest
    return ProjectInfo(
        id=m.id,
        name=m.name,
        created_at=m.created_at,
        updated_at=m.updated_at,
        roots=m.roots,
        split_options=m.split_options,
        stats=stats,
    )


@router.post("", response_model=ProjectInfo, status_code=201)
def create_project(
    payload: ProjectCreateRequest,
    store: Annotated[ProjectStore, Depends(get_project_store)],
) -> ProjectInfo:
    try:
        ctx = store.create_project(payload.name, payload.roots, payload.split_options)
    except ProjectValidationError as exc:
        raise ApiError(400, "invalid_roots", str(exc)) from None
    except OSError as exc:
        raise ApiError(
            500,
            "storage_error",
            f"cannot create project directory: {exc.__class__.__name__}",
            "Check that the data directory is writable (see /api/health).",
        ) from None
    return _project_info(ctx, with_stats=False)


@router.get("", response_model=list[ProjectSummaryDTO])
def list_projects(
    store: Annotated[ProjectStore, Depends(get_project_store)],
) -> list[ProjectSummaryDTO]:
    return [
        ProjectSummaryDTO(
            id=s.id, name=s.name, updated_at=s.updated_at, roots=s.roots, error=s.error
        )
        for s in store.list_projects()
    ]


@router.get("/{project_id}", response_model=ProjectInfo)
def get_project_info(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> ProjectInfo:
    return _project_info(ctx, with_stats=True)


@router.delete("/{project_id}")
def delete_project(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    store: Annotated[ProjectStore, Depends(get_project_store)],
    confirm: Annotated[bool, Query()] = False,
) -> dict[str, str]:
    if not confirm:
        raise ApiError(
            400,
            "confirm_required",
            "Deleting a project removes its database, caches and experiments.",
            "Repeat the request with ?confirm=true after user confirmation.",
        )
    store.delete(ctx.id)
    return {"deleted": ctx.id}


@router.get("/{project_id}/changes", response_model=ChangesReport)
def get_changes(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> ChangesReport:
    """Live scan + diff preview. Does NOT modify anything (scenario D)."""
    inputs = build_index_inputs(ctx)
    scan, plan = inputs.scan, inputs.plan
    return ChangesReport(
        new=[
            FileChangeDTO(root=c.root, rel_path=c.rel_path, size=c.size, reason=c.reason)  # type: ignore[arg-type]
            for c in plan.new
        ],
        modified=[
            FileChangeDTO(root=c.root, rel_path=c.rel_path, size=c.size, reason=c.reason)  # type: ignore[arg-type]
            for c in plan.modified
        ],
        deleted=[f"{d.rel_path}" for d in plan.deleted],
        unchanged_count=plan.unchanged_count,
        skipped=[
            SkippedFileDTO(path=s.path, reason=s.reason, detail=s.detail) for s in scan.skipped
        ],
        root_errors=scan.root_errors,
        warnings=scan.warnings,
    )


@router.get("/{project_id}/staleness", response_model=StalenessReport)
def get_staleness(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> StalenessReport:
    """Lightweight "needs re-index?" probe for the UI indicator.

    Full scan with the project's exclusion rules (so skipped/binary/secret
    files never light the indicator), but classification without content
    hashing. Does NOT modify anything.
    """
    inputs = compute_staleness(ctx)
    plan = inputs.plan
    return StalenessReport(
        dirty=bool(plan.new or plan.modified or plan.deleted),
        new_count=len(plan.new),
        modified_count=len(plan.modified),
        deleted_count=len(plan.deleted),
        unchanged_count=plan.unchanged_count,
        root_errors=inputs.scan.root_errors,
    )


@router.post("/{project_id}/index", response_model=JobInfo, status_code=202)
def start_index(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    manager: Annotated[JobManager, Depends(get_job_manager)],
    response: Response,
) -> JobInfo:
    """Start (incremental) indexing as a background job."""
    with ctx.session_factory() as session:
        active = (
            session.execute(
                select(JobRow).where(
                    JobRow.kind == "index", JobRow.state.in_(("queued", "running"))
                )
            )
            .scalars()
            .first()
        )
    if active is not None:
        raise ApiError(
            409,
            "index_already_running",
            "An indexing job is already active for this project.",
            "Wait for it to finish or cancel it first.",
        )
    job_id = manager.submit(ctx, "index", run_index_job)
    response.status_code = 202
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)
