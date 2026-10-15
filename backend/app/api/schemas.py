"""Pydantic DTOs for the HTTP API.

These mirror `frontend/src/api/types.ts`. Field names are snake_case and
stable; validation is mandatory for every external input (TZ §17.4).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.fragmentation.base import SplitOptions

CheckStatus = Literal["ok", "warn", "error"]
OverallStatus = Literal["ok", "degraded", "error"]
JobState = Literal["queued", "running", "done", "failed", "cancelled"]
FileStatus = Literal["indexed", "skipped", "error"]


class ErrorDetail(BaseModel):
    """Machine-readable error code plus a human-facing message and next step."""

    code: str
    message: str
    hint: str | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


# ---------------------------------------------------------------------------
# Health (stage 0)
# ---------------------------------------------------------------------------


class DependencyInfo(BaseModel):
    """A runtime dependency: installed version or the stage where it is planned."""

    name: str
    installed: bool
    version: str | None = None
    required: bool
    planned_stage: str | None = Field(
        default=None,
        description="Development stage that introduces this dependency, e.g. 'stage-2'.",
    )


class CheckResult(BaseModel):
    """A single diagnostic check with a non-color-only status."""

    name: str
    status: CheckStatus
    detail: str


class HealthResponse(BaseModel):
    """Full backend diagnostics payload for GET /api/health."""

    status: OverallStatus
    app_name: str
    app_version: str
    schema_version: int
    python_version: str
    platform: str
    server_host: str
    server_port: int
    loopback_only: bool
    data_dir: str
    dependencies: list[DependencyInfo]
    checks: list[CheckResult]


# ---------------------------------------------------------------------------
# Projects (stage 1)
# ---------------------------------------------------------------------------


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    roots: list[str] = Field(min_length=1, max_length=32)
    split_options: SplitOptions | None = None


class ProjectStats(BaseModel):
    files_indexed: int
    files_error: int
    fragments: int
    running_job_id: str | None = None


class ProjectInfo(BaseModel):
    id: str
    name: str
    created_at: str
    updated_at: str
    roots: list[str]
    split_options: SplitOptions
    stats: ProjectStats | None = None


class ProjectSummaryDTO(BaseModel):
    id: str
    name: str
    updated_at: str
    roots: list[str] = Field(default_factory=list)
    error: str | None = None


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


class JobInfo(BaseModel):
    id: str
    kind: str
    state: JobState
    progress_done: int
    progress_total: int
    message: str | None = None
    error: str | None = None
    warnings: list[str] = Field(default_factory=list)
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None


# ---------------------------------------------------------------------------
# Files & fragments
# ---------------------------------------------------------------------------


class FileSummary(BaseModel):
    id: str
    root: str
    rel_path: str
    size: int
    mtime: float
    language: str | None = None
    status: FileStatus
    skip_reason: str | None = None
    detail: str | None = None
    indexed_at: str | None = None
    fragment_count: int = 0


class FragmentMeta(BaseModel):
    id: str
    file_id: str
    kind: str
    name: str | None = None
    symbol_path: str
    parent_symbol_path: str | None = None
    start_line: int
    end_line: int
    method: str
    language: str
    ordinal: int


class FragmentDetail(FragmentMeta):
    rel_path: str
    start_offset: int
    end_offset: int
    content_hash: str
    text: str


class FileDetail(BaseModel):
    file: FileSummary
    fragments: list[FragmentMeta]


class FileContentResponse(BaseModel):
    file_id: str
    rel_path: str
    language: str | None
    content: str
    total_lines: int


class LocateRequest(BaseModel):
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)

    @model_validator(mode="after")
    def _check_order(self) -> LocateRequest:
        if self.end_line < self.start_line:
            raise ValueError("end_line must be >= start_line")
        return self


class LocateResponse(BaseModel):
    fragments: list[FragmentMeta]
    ambiguous: bool
    note: str | None = None


class FragmentSearchItem(FragmentMeta):
    rel_path: str


class FragmentSearchResponse(BaseModel):
    items: list[FragmentSearchItem]
    total: int
    limit: int
    offset: int


# ---------------------------------------------------------------------------
# Changes (scenario D)
# ---------------------------------------------------------------------------


class FileChangeDTO(BaseModel):
    root: str
    rel_path: str
    size: int
    reason: Literal["new", "content", "size"]


class SkippedFileDTO(BaseModel):
    path: str
    reason: str
    detail: str


class ChangesReport(BaseModel):
    new: list[FileChangeDTO]
    modified: list[FileChangeDTO]
    deleted: list[str]
    unchanged_count: int
    skipped: list[SkippedFileDTO] = Field(default_factory=list)
    root_errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Filesystem browser (root picker)
# ---------------------------------------------------------------------------


class FsDirEntry(BaseModel):
    name: str
    path: str


class FsListResponse(BaseModel):
    path: str | None
    parent: str | None
    entries: list[FsDirEntry]
    drives: bool = False
