"""Pydantic DTOs for the HTTP API.

These mirror `frontend/src/api/types.ts`. Field names are snake_case and
stable; validation is mandatory for every external input.
"""

from __future__ import annotations

from typing import Any, Literal

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
# Health
# ---------------------------------------------------------------------------


class DependencyInfo(BaseModel):
    """A runtime dependency: installed version or an honest «not installed»."""

    name: str
    installed: bool
    version: str | None = None
    required: bool


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
# Projects
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
    #: structured result of a finished job (e.g. {"projection_run_ids": [...]})
    result: dict[str, Any] | None = None
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
# Embeddings
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
    #: vectors computed from text the tokenizer TRUNCATED to the model limit
    truncated_count: int = 0
    coverage: CoverageDTO
    created_at: str
    updated_at: str


class PreparationPreviewsDTO(BaseModel):
    """Exact prepared-text previews per mode (single source of truth for UI)."""

    raw_fragment: str
    context_enriched: str


# ---------------------------------------------------------------------------
# Projections
# ---------------------------------------------------------------------------

ProjectionParamType = Literal["int", "float", "bool", "choice", "int_list"]

#: Parameter values: scalars or an integer list (raw-axes selection).
ProjectionParamValue = bool | int | float | str | list[int]


class ProjectionParamSpecDTO(BaseModel):
    """One tunable parameter of a projection method (drives the UI form)."""

    name: str
    type: ProjectionParamType
    default: ProjectionParamValue
    description: str
    min_value: float | None = None
    max_value: float | None = None
    step: float | None = None
    choices: list[str] | None = None
    min_items: int | None = None
    max_items: int | None = None


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
    #: which display spaces to compute: 3 (3D scene), 2 (2D map), 4 (4D view:
    #: 3D scene + "time" slider over the 4th axis); [3, 2] by default.
    #: Ignored (derived from `axes`) for the raw_axes method.
    components: list[int] = Field(default_factory=lambda: [3, 2], min_length=1, max_length=2)
    params: dict[str, ProjectionParamValue] = Field(default_factory=dict)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)
    #: raw_axes only: several axis PAIRS in one job — one 2D projection per
    #: pair, shown side by side for comparison ("0,1;0,2" in the UI). Each
    #: pair is a normal projection run (own fingerprint/cache/inventory row).
    axis_sets: list[list[int]] | None = Field(default=None, min_length=2, max_length=6)

    @field_validator("axis_sets")
    @classmethod
    def _check_axis_sets(cls, value: list[list[int]] | None) -> list[list[int]] | None:
        if value is None:
            return None
        for item in value:
            if len(item) != 2:
                raise ValueError("each axis set must contain exactly 2 axes (2D comparison)")
            if item[0] == item[1]:
                raise ValueError(f"axis set {item} repeats the same axis")
        seen: list[list[int]] = []
        for item in value:
            if item in seen:
                raise ValueError(f"duplicate axis set {item}")
            seen.append(item)
        return value

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
    params: dict[str, ProjectionParamValue]
    seed: int
    axis_labels: list[str]
    #: per-axis interpretability numbers — MEANING DEPENDS ON THE METHOD:
    #: PCA → explained variance ratio (0..1), raw_axes → σ of the original
    #: coordinates, UMAP → None. The UI must label them per method.
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


class ProjectionPresetDTO(BaseModel):
    """Named projection form state (method + params + seed), project-scoped."""

    id: str
    name: str
    method: str
    method_display_name: str
    params: dict[str, ProjectionParamValue]
    seed: int
    created_at: str


class CreatePresetRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    method: str = Field(min_length=1, max_length=32)
    params: dict[str, ProjectionParamValue] = Field(default_factory=dict)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)


# ---------------------------------------------------------------------------
# slices of the ORIGINAL space
# ---------------------------------------------------------------------------


SliceNormalKind = Literal["axis", "pca", "vector"]


class SliceNormalDTO(BaseModel):
    """How the hyperplane normal is specified (MVP: axis / PCA direction /
    explicit vector; the resolved unit vector is returned/stored)."""

    kind: SliceNormalKind
    index: int | None = Field(default=None, ge=0)
    vector: list[float] | None = None


class ComputeSliceRequest(BaseModel):
    embedding_run_id: str = Field(min_length=1, max_length=32)
    normal: SliceNormalDTO
    #: signed offset of the plane point from the run centroid along n
    position: float = 0.0
    #: layer thickness t (|d(x)| <= t/2 membership), raw units
    thickness: float = Field(0.0, ge=0.0)
    #: ABSOLUTE plane coordinate dot(x, n) of a saved slice: membership is
    #: computed against it (reproducible across corpus changes), `position`
    #: then only serves to report the drift (audit #6)
    plane_offset: float | None = None


class SliceComputeResponse(BaseModel):
    embedding_run_id: str
    normal_kind: str
    normal_index: int | None = None
    dim: int
    #: EFFECTIVE relative position (what membership was computed with — the
    #: client mask formula |u - position| <= t/2 always matches in_layer)
    position: float
    thickness: float
    #: dot(centroid, n) of the CURRENT vectors — the zero point of `position`
    centroid_offset: float
    #: absolute plane coordinate dot(x, n) — persist this to reproduce the
    #: plane after the corpus changes
    plane_offset: float
    #: position_used - requested position when plane_offset was given (how
    #: far the centroid drifted since saving); null for plain computes
    drift: float | None = None
    total: int
    in_layer: int
    #: range of the coordinate along the normal (slider bounds for the UI)
    u_min: float
    u_max: float
    #: per fragment: signed coordinate u(x) = dot(x - centroid, n)
    ids: list[str]
    u: list[float]
    #: honest interpretation note (a selection in the ORIGINAL space; the
    #: points are DISPLAYED through the active projection)
    note: str


class CreateSliceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    embedding_run_id: str = Field(min_length=1, max_length=32)
    normal: SliceNormalDTO
    position: float = 0.0
    thickness: float = Field(0.0, ge=0.0)


class SavedSliceDTO(BaseModel):
    id: str
    name: str
    embedding_run_id: str
    normal_kind: str
    normal_index: int | None = None
    dim: int
    #: resolved unit normal at save time (reproducibility)
    vector: list[float]
    #: relative position at save time (slider units, centroid of that time)
    position: float
    thickness: float
    #: ABSOLUTE plane coordinate dot(x, n) at save time — the reproducible
    #: anchor; null for slices saved before schema v7 (relative-only)
    plane_offset: float | None = None
    created_at: str


# ---------------------------------------------------------------------------
# semantic neighbors
# ---------------------------------------------------------------------------


class NeighborsRequest(BaseModel):
    fragment_id: str = Field(min_length=1, max_length=16)
    k: int = Field(5, ge=1, le=50)
    metric: Literal["cosine", "euclidean"] = "cosine"
    #: None → the most recently updated embedding run
    embedding_run_id: str | None = Field(default=None, max_length=32)


class NeighborDTO(BaseModel):
    fragment_id: str
    file_id: str
    rel_path: str
    kind: str
    name: str | None = None
    symbol_path: str
    start_line: int
    end_line: int
    #: metric-dependent distance (smaller = closer)
    distance: float
    #: metric-dependent similarity (larger = closer): cosine → similarity in
    #: [-1, 1]; euclidean → -distance. The response names the metric.
    score: float


class NeighborsResponse(BaseModel):
    fragment_id: str
    embedding_run_id: str
    metric: str
    k: int
    total_vectors: int
    neighbors: list[NeighborDTO]
    #: candidate vectors skipped because their fragment row no longer exists
    #: (deleted after the vectors were computed; reindex prunes them) — the
    #: list is refilled from the next candidates, and the drop is REPORTED,
    #: never silent (audit #10)
    dropped_stale: int = 0
    #: honest note: computed over the ORIGINAL embeddings, never projections
    note: str


# ---------------------------------------------------------------------------
# structural relations
# ---------------------------------------------------------------------------


class RelationEndpointDTO(BaseModel):
    """One side of a relation: a fragment and/or its file (file-level
    endpoints are honest first-class citizens — e.g. a top-level import)."""

    file_id: str | None = None
    fragment_id: str | None = None
    rel_path: str | None = None
    name: str | None = None
    symbol_path: str | None = None
    start_line: int | None = None
    end_line: int | None = None


class RelationDTO(BaseModel):
    id: str
    kind: str
    #: extracted | imported | manual — provenance is never mixed
    origin: str
    confidence: float | None = None
    detail: str | None = None
    created_at: str
    source: RelationEndpointDTO
    target: RelationEndpointDTO


class RelationsResponse(BaseModel):
    items: list[RelationDTO]
    total: int
    limit: int
    offset: int
    counts_by_kind: dict[str, int]
    counts_by_origin: dict[str, int]


class CreateRelationRequest(BaseModel):
    source_fragment_id: str = Field(min_length=1, max_length=16)
    target_fragment_id: str = Field(min_length=1, max_length=16)
    kind: str = Field(min_length=1, max_length=32)
    detail: str | None = Field(default=None, max_length=512)


class UnresolvedRelationDTO(BaseModel):
    index: int
    kind: str
    reason: str


class ImportRelationsResponse(BaseModel):
    imported: int
    duplicates: int
    unresolved: list[UnresolvedRelationDTO]


# ---------------------------------------------------------------------------
# clustering and manual groups
# ---------------------------------------------------------------------------


class ClusteringParamsDTO(BaseModel):
    eps: float = Field(0.5, gt=0.0)
    min_samples: int = Field(5, ge=2)


class ComputeClusteringRequest(BaseModel):
    embedding_run_id: str = Field(min_length=1, max_length=32)
    #: the space is EXPLICIT and persisted: original vectors or one projection
    space: Literal["original", "projection"] = "original"
    projection_run_id: str | None = Field(default=None, max_length=32)
    algorithm: Literal["dbscan"] = "dbscan"
    #: default: cosine for original vectors, euclidean for projection coords
    metric: Literal["cosine", "euclidean"] | None = None
    #: None → defaults (eps 0.5, min_samples 5) resolved by the endpoint
    params: ClusteringParamsDTO | None = None


class ClusteringRunDTO(BaseModel):
    id: str
    embedding_run_id: str
    space: str
    projection_run_id: str | None = None
    algorithm: str
    metric: str
    params: ClusteringParamsDTO
    count: int
    n_clusters: int
    #: DBSCAN noise (-1): shown as «шум/не определено», never as a meaning
    noise: int
    stale: bool
    cache_ok: bool
    versions: dict[str, str]
    created_at: str
    updated_at: str


class ClusteringLabelsDTO(BaseModel):
    clustering_id: str
    space: str
    algorithm: str
    metric: str
    n_clusters: int
    noise: int
    count: int
    #: parallel arrays: labels[i] ∈ {-1 (noise), 0..n_clusters-1} of ids[i]
    ids: list[str]
    labels: list[int]


class CreateGroupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    fragment_ids: list[str] = Field(min_length=1)


class FragmentGroupDTO(BaseModel):
    id: str
    name: str
    count: int
    #: member fragment ids (groups store ids, not screen coordinates, §8.2);
    #: members deleted by a reindex cascade away — the count stays honest
    fragment_ids: list[str]
    created_at: str


# ---------------------------------------------------------------------------
# metrics
# ---------------------------------------------------------------------------


class ComputeMetricsRequest(BaseModel):
    embedding_run_id: str = Field(min_length=1, max_length=32)
    #: None → only the relation metrics (over the ORIGINAL space) are computed
    projection_run_id: str | None = Field(default=None, max_length=32)
    k: int = Field(10, ge=1, le=100)
    #: deterministic sample of points the projection metrics run over
    sample: int = Field(500, ge=3, le=100_000)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)
    #: None = every relation kind counts as "known"
    relation_kinds: list[str] | None = None


class MetricValueDTO(BaseModel):
    """One metric: value + everything needed to interpret it (never a bare
    number)."""

    value: float | None = None
    #: random-ranking baseline (relation metrics): the expected value by chance
    baseline: float | None = None
    #: value / baseline (>1 = the space agrees with relations better than chance)
    lift: float | None = None
    k: int | None = None
    n_sampled: int | None = None
    n_sampled_with_relations: int | None = None
    n_known_pairs_embedded: int | None = None
    n_pairs_considered: int | None = None
    explanation: str


class MetricRunDTO(BaseModel):
    id: str
    embedding_run_id: str
    projection_run_id: str | None = None
    k: int
    sample_size: int
    seed: int
    relation_kinds: list[str] | None = None
    n_vectors: int
    metrics: dict[str, MetricValueDTO]
    #: relation metrics per relation kind over the SAME sample/top-k: the
    #: mixed value is dominated by trivial belongs_to pairs (audit #4)
    per_kind: dict[str, dict[str, MetricValueDTO]] = {}
    warnings: list[str]
    stale: bool
    versions: dict[str, str]
    created_at: str
    updated_at: str


# ---------------------------------------------------------------------------
# experiments
# ---------------------------------------------------------------------------


class ExperimentSliceDTO(BaseModel):
    #: a saved slice (restored by its RESOLVED normal vector) …
    saved_slice_id: str | None = None
    #: … or an inline definition re-resolved at open time
    embedding_run_id: str | None = None
    normal_kind: SliceNormalKind | None = None
    normal_index: int | None = None
    normal_vector: list[float] | None = None
    position: float | None = None
    thickness: float | None = None
    #: absolute plane anchor of the inline definition (audit #6): without it
    #: a restored inline slice would sit on a centroid-relative position
    plane_offset: float | None = None


class ExperimentProjectionsDTO(BaseModel):
    three: str | None = None
    two: list[str] = Field(default_factory=list)
    four: str | None = None


class ExperimentConfigDTO(BaseModel):
    """The captured SPACE state (frontend-owned shape, backend-validated
    references). Extra keys are rejected — a typo must not silently vanish."""

    model_config = {"extra": "forbid"}

    view_mode: Literal["3d", "2d", "4d", "split"] = "3d"
    embedding_run_id: str | None = None
    projections: ExperimentProjectionsDTO = Field(default_factory=ExperimentProjectionsDTO)
    slice: ExperimentSliceDTO | None = None
    slice_display: Literal["off", "dim", "only"] = "dim"
    clustering_run_id: str | None = None
    color_by: Literal["kind", "file", "cluster"] = "kind"
    group_ids: list[str] = Field(default_factory=list)
    selection: list[str] = Field(default_factory=list)
    #: true when the selection was truncated at save time (cap 5000)
    selection_truncated: bool = False
    metric_run_ids: list[str] = Field(default_factory=list)


class CreateExperimentRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=2048)
    config: ExperimentConfigDTO


class ExperimentSummaryDTO(BaseModel):
    id: str
    name: str
    description: str | None = None
    created_at: str
    #: short human-facing content summary built at save time
    summary: dict[str, object]


class ExperimentLiveStatusDTO(BaseModel):
    #: references that no longer exist, by config field
    missing: dict[str, list[str]]
    #: references that exist but are marked stale (vectors changed since)
    stale: dict[str, list[str]]


class ExperimentDTO(BaseModel):
    id: str
    name: str
    description: str | None = None
    config: ExperimentConfigDTO
    #: interpretation context captured AT SAVE TIME (corpus, versions,
    #: staleness, metric values) — reopening never relies on live state alone
    snapshot: dict[str, object]
    live_status: ExperimentLiveStatusDTO | None = None
    created_at: str


class ExportFragmentsRequest(BaseModel):
    """Explicit selection to export (only data the user chose)."""

    fragment_ids: list[str] = Field(min_length=1, max_length=20_000)


# ---------------------------------------------------------------------------
# Research workspace (notebooks, notes, exports — TZ §3, §10)
# ---------------------------------------------------------------------------

WorkspaceEntryKind = Literal["dir", "file"]


class WorkspaceEntryDTO(BaseModel):
    """One row of the workspace tree; `path` is POSIX-relative to workspace/."""

    path: str
    name: str
    kind: WorkspaceEntryKind
    size: int = 0
    mtime: float = 0.0


class WorkspaceTreeResponse(BaseModel):
    entries: list[WorkspaceEntryDTO]
    truncated: bool = False
    #: Absolute path of the workspace root (display/copy only, never an input).
    root: str


class WorkspaceFileContent(BaseModel):
    path: str
    content: str
    size: int
    mtime: float


class WorkspaceCreateRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    content: str = Field(default="", max_length=16 * 1024 * 1024)
    kind: WorkspaceEntryKind = "file"


class WorkspaceSaveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    content: str = Field(max_length=16 * 1024 * 1024)
    #: mtime the client last saw; server refuses an overwrite when the file
    #: changed since (409 workspace_conflict) unless force=True.
    base_mtime: float | None = None
    force: bool = False


class WorkspaceRenameRequest(BaseModel):
    from_path: str = Field(min_length=1, max_length=2048)
    to_path: str = Field(min_length=1, max_length=2048)


class OpenFolderRequest(BaseModel):
    """Only a FIXED subdir name is accepted (never an arbitrary path)."""

    sub: str = Field(default="", max_length=64)


class OpenFolderResponse(BaseModel):
    opened: bool
    path: str
    error: str | None = None


# ---------------------------------------------------------------------------
# Jupyter Notebooks (.ipynb) and kernel sessions (TZ §5)
# ---------------------------------------------------------------------------


class NotebookListItem(BaseModel):
    path: str
    name: str
    size: int
    mtime: float


class NotebookContentResponse(BaseModel):
    path: str
    #: The notebook document exactly as nbformat sees it (cells/outputs/metadata).
    notebook: dict[str, Any]
    valid: bool
    problems: list[str] = Field(default_factory=list)
    mtime: float
    size: int
    #: Project recorded in metadata.ese at creation (None for foreign files).
    ese_project_id: str | None = None


class NotebookCreateRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)


class NotebookSaveRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)
    notebook: dict[str, Any]
    base_mtime: float | None = None
    force: bool = False


class NotebookSaveResponse(BaseModel):
    path: str
    mtime: float
    size: int
    valid: bool
    problems: list[str] = Field(default_factory=list)


class KernelSessionRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)


class KernelSessionDTO(BaseModel):
    session_id: str
    project_id: str
    path: str
    #: starting | ready | restarting | dead | error
    state: str
    error: str | None = None
    busy: bool = False
    started_at: float
    last_used: float


class NotebookExecuteRequest(BaseModel):
    code: str = Field(max_length=2 * 1024 * 1024)


class NotebookExecuteResponse(BaseModel):
    execution_id: str
    status: str


class NotebookExecutionDTO(BaseModel):
    id: str
    #: running | done | error | interrupted | aborted
    status: str
    outputs: list[dict[str, Any]] = Field(default_factory=list)
    execution_count: int | None = None
    error: str | None = None
    truncated: bool = False
    started_at: float
    finished_at: float | None = None


# ---------------------------------------------------------------------------
# ese bridge help (in-app reference for the notebook Python API)
# ---------------------------------------------------------------------------


class EseApiEntry(BaseModel):
    name: str
    #: function | method | property
    kind: str
    #: owning class for methods/properties (None for module functions)
    owner: str | None = None
    signature: str
    doc: str


class EseHelpContext(BaseModel):
    """Live paths and identifiers of the CURRENT project (no guessing)."""

    project_id: str
    project_name: str
    roots: list[str]
    data_dir: str
    project_dir: str
    workspace_dir: str
    notebooks_dir: str
    notes_dir: str
    results_dir: str
    exports_dir: str
    kernel_env: dict[str, str]


class EseHelpResponse(BaseModel):
    context: EseHelpContext
    quickstart: str
    api: list[EseApiEntry]
