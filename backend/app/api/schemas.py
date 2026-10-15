"""Pydantic DTOs for the HTTP API.

These mirror `frontend/src/api/types.ts`. Field names are snake_case and
stable; validation is mandatory for every external input (TZ §17.4).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

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


class StalenessReport(BaseModel):
    """Cheap indicator: does the corpus need re-indexing?

    Computed without content hashing (size/mtime only), so it may slightly
    over-report after touch-only changes; GET /changes gives the verified
    picture. Used to light up the "Changes" button in the UI.
    """

    dirty: bool
    new_count: int
    modified_count: int
    deleted_count: int
    unchanged_count: int
    root_errors: list[str] = Field(default_factory=list)


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


# ---------------------------------------------------------------------------
# Embeddings (stage 2)
# ---------------------------------------------------------------------------

PrepMode = Literal["raw_fragment", "context_enriched"]


class ModelInfoDTO(BaseModel):
    model_id: str
    display_name: str
    dim: int
    approx_download_mb: int
    description: str
    is_default: bool
    downloaded: bool


class DownloadModelRequest(BaseModel):
    model_id: str = Field(min_length=1, max_length=256)


class ComputeEmbeddingsRequest(BaseModel):
    model_id: str = Field(min_length=1, max_length=256)
    mode: PrepMode
    batch_size: int = Field(default=16, ge=1, le=128)


class CoverageDTO(BaseModel):
    fragments_total: int
    embedded: int
    stale: int
    missing: int


class EmbeddingRunDTO(BaseModel):
    id: str
    model_id: str
    model_display_name: str
    dim: int
    mode: PrepMode
    template_preview: str
    params: dict[str, int | bool | str]
    count: int
    coverage: CoverageDTO
    created_at: str
    updated_at: str


class PreparationPreviewsDTO(BaseModel):
    """Exact prepared-text previews per mode (single source of truth for UI)."""

    raw_fragment: str
    context_enriched: str


# ---------------------------------------------------------------------------
# Projections (stage 3)
# ---------------------------------------------------------------------------

ProjectionParamType = Literal["int", "float", "bool", "choice"]


class ProjectionParamSpecDTO(BaseModel):
    """One tunable parameter of a projection method (drives the UI form)."""

    name: str
    type: ProjectionParamType
    default: bool | int | float | str
    description: str
    min_value: float | None = None
    max_value: float | None = None
    step: float | None = None
    choices: list[str] | None = None


class ProjectionMethodInfoDTO(BaseModel):
    """Catalog entry: what the method is, its caveats and parameters."""

    method_id: str
    display_name: str
    description: str
    caveat: str
    available: bool
    supported_components: list[int]
    params: list[ProjectionParamSpecDTO]


class ComputeProjectionRequest(BaseModel):
    embedding_run_id: str = Field(min_length=1, max_length=32)
    method: str = Field(min_length=1, max_length=32)
    #: which display spaces to compute: 3 (3D scene), 2 (2D map); both by default
    components: list[int] = Field(default_factory=lambda: [3, 2], min_length=1, max_length=2)
    params: dict[str, bool | int | float | str] = Field(default_factory=dict)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)

    @field_validator("components")
    @classmethod
    def _check_components(cls, value: list[int]) -> list[int]:
        from app.projection_methods.base import SUPPORTED_COMPONENTS

        seen: list[int] = []
        for item in value:
            if item not in SUPPORTED_COMPONENTS:
                raise ValueError(
                    f"components must be a subset of {list(SUPPORTED_COMPONENTS)}, got {item}"
                )
            if item not in seen:
                seen.append(item)
        return seen


class ProjectionRunDTO(BaseModel):
    """Inventory entry: one cached projection of one embedding run."""

    id: str
    embedding_run_id: str
    method: str
    method_display_name: str
    n_components: int
    params: dict[str, bool | int | float | str]
    seed: int
    axis_labels: list[str]
    #: PCA explained variance ratio per axis; None for methods without it
    axis_info: list[float] | None = None
    count: int
    #: vectors changed since compute (or embedding run gone) → recompute
    stale: bool
    #: coordinate .npz readable; false → serve 409 on points, offer recompute
    cache_ok: bool
    versions: dict[str, str]
    created_at: str
    updated_at: str


class ProjectionPointDTO(BaseModel):
    """One point: display coordinates + full traceability to the source."""

    fragment_id: str
    file_id: str
    rel_path: str
    kind: str
    name: str | None = None
    symbol_path: str
    start_line: int
    end_line: int
    coords: list[float]


class ProjectionPointsDTO(BaseModel):
    projection_id: str
    method: str
    method_display_name: str
    n_components: int
    axis_labels: list[str]
    axis_info: list[float] | None = None
    stale: bool
    count: int
    #: points whose fragments were deleted since compute (not served)
    dropped_orphans: int
    points: list[ProjectionPointDTO]
