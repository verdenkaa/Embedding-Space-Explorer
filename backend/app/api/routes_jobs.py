"""Job endpoints: status polling and cancellation (TZ §10: polling, no WS)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.api.deps import get_job_manager, get_project
from app.api.errors import ApiError
from app.api.schemas import JobInfo
from app.api.serialization import job_info_from_row
from app.jobs.manager import JobManager
from app.storage.models import JobRow
from app.storage.projects_store import ProjectContext

router = APIRouter(prefix="/api/projects/{project_id}", tags=["jobs"])


@router.get("/jobs", response_model=list[JobInfo])
def list_jobs(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> list[JobInfo]:
    with ctx.session_factory() as session:
        rows = (
            session.execute(select(JobRow).order_by(JobRow.created_at.desc()).limit(limit))
            .scalars()
            .all()
        )
        return [job_info_from_row(r) for r in rows]


@router.get("/jobs/{job_id}", response_model=JobInfo)
def get_job(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    job_id: str,
) -> JobInfo:
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        if row is None:
            raise ApiError(404, "job_not_found", f"Job '{job_id}' is not in this project.")
        return job_info_from_row(row)


@router.post("/jobs/{job_id}/cancel", response_model=JobInfo)
def cancel_job(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    job_id: str,
    manager: Annotated[JobManager, Depends(get_job_manager)],
) -> JobInfo:
    if not manager.cancel(ctx, job_id):
        with ctx.session_factory() as session:
            row = session.get(JobRow, job_id)
            if row is None:
                raise ApiError(404, "job_not_found", f"Job '{job_id}' is not in this project.")
            raise ApiError(
                409,
                "job_not_cancellable",
                f"Job is already '{row.state}'.",
                "Only queued or running jobs can be cancelled.",
            )
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return job_info_from_row(row)
