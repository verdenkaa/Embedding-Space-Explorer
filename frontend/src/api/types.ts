/**
 * DTO types mirroring backend Pydantic schemas (backend/app/api/schemas.py).
 * The backend is the single source of truth; keep these in sync when the
 * schema changes.
 */

export type CheckStatus = "ok" | "warn" | "error";
export type OverallStatus = "ok" | "degraded" | "error";

export interface ErrorDetail {
  code: string;
  message: string;
  hint?: string | null;
}

export interface ErrorResponse {
  error: ErrorDetail;
}

export interface DependencyInfo {
  name: string;
  installed: boolean;
  version: string | null;
  required: boolean;
}

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface HealthResponse {
  status: OverallStatus;
  app_name: string;
  app_version: string;
  schema_version: number;
  python_version: string;
  platform: string;
  server_host: string;
  server_port: number;
  loopback_only: boolean;
  data_dir: string;
  dependencies: DependencyInfo[];
  checks: CheckResult[];
}

/* ------------------------------------------------------------------ */
/* projects, corpus, jobs */
/* ------------------------------------------------------------------ */

export interface SplitOptions {
  max_file_size_bytes: number;
  max_fragment_lines: number;
  fallback_chunk_lines: number;
  fallback_overlap_lines: number;
  include_hidden: boolean;
  extra_include_patterns: string[];
  extra_exclude_patterns: string[];
  allow_symlinks_outside_root: boolean;
}

export interface ProjectStats {
  files_indexed: number;
  files_error: number;
  fragments: number;
  running_job_id: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  roots: string[];
  split_options: SplitOptions;
  stats: ProjectStats | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updated_at: string;
  roots: string[];
  error: string | null;
}

export interface CreateProjectRequest {
  name: string;
  roots: string[];
  split_options?: Partial<SplitOptions> | null;
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobInfo {
  id: string;
  kind: string;
  state: JobState;
  progress_done: number;
  progress_total: number;
  message: string | null;
  error: string | null;
  warnings: string[];
  /** structured result of a finished job (e.g. { projection_run_ids: [...] }) */
  result?: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type FileStatus = "indexed" | "skipped" | "error";

export interface FileSummary {
  id: string;
  root: string;
  rel_path: string;
  size: number;
  mtime: number;
  language: string | null;
  status: FileStatus;
  skip_reason: string | null;
  detail: string | null;
  indexed_at: string | null;
  fragment_count: number;
}

export interface FragmentMeta {
  id: string;
  file_id: string;
  kind: string;
  name: string | null;
  symbol_path: string;
  parent_symbol_path: string | null;
  start_line: number;
  end_line: number;
  method: string;
  language: string;
  ordinal: number;
}

export interface FragmentDetail extends FragmentMeta {
  rel_path: string;
  start_offset: number;
  end_offset: number;
  content_hash: string;
  text: string;
}

export interface FileDetail {
  file: FileSummary;
  fragments: FragmentMeta[];
}

export interface FileContent {
  file_id: string;
  rel_path: string;
  language: string | null;
  content: string;
  total_lines: number;
}

export interface LocateResponse {
  fragments: FragmentMeta[];
  ambiguous: boolean;
  note: string | null;
}

export interface FragmentSearchItem extends FragmentMeta {
  rel_path: string;
}

export interface FragmentSearchResponse {
  items: FragmentSearchItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface FileChangeDTO {
  root: string;
  rel_path: string;
  size: number;
  reason: "new" | "content" | "size";
}

export interface SkippedFileDTO {
  path: string;
  reason: string;
  detail: string;
}

export interface ChangesReport {
  new: FileChangeDTO[];
  modified: FileChangeDTO[];
  deleted: string[];
  unchanged_count: number;
  skipped: SkippedFileDTO[];
  root_errors: string[];
  warnings: string[];
}

export interface FsDirEntry {
  name: string;
  path: string;
}

export interface FsListResponse {
  path: string | null;
  parent: string | null;
  entries: FsDirEntry[];
  drives: boolean;
}

export interface StalenessReport {
  dirty: boolean;
  new_count: number;
  modified_count: number;
  deleted_count: number;
  unchanged_count: number;
  root_errors: string[];
}

/* ------------------------------------------------------------------ */
/* embeddings */
/* ------------------------------------------------------------------ */

export type PrepMode = "raw_fragment" | "context_enriched";

export interface ModelInfo {
  model_id: string;
  display_name: string;
  dim: number;
  approx_download_mb: number;
  description: string;
  is_default: boolean;
  downloaded: boolean;
}

export interface ComputeEmbeddingsRequest {
  model_id: string;
  mode: PrepMode;
  batch_size: number;
}

export interface CoverageDTO {
  fragments_total: number;
  embedded: number;
  stale: number;
  missing: number;
}

export interface EmbeddingRunDTO {
  id: string;
  model_id: string;
  model_display_name: string;
  dim: number;
  mode: PrepMode;
  template_preview: string;
  params: Record<string, string | number | boolean>;
  count: number;
  /** vectors computed from text the tokenizer TRUNCATED to the model limit */
  truncated_count?: number;
  coverage: CoverageDTO;
  created_at: string;
  updated_at: string;
}

export interface PreparationPreviews {
  raw_fragment: string;
  context_enriched: string;
}

/* ------------------------------------------------------------------ */
/* projections */
/* ------------------------------------------------------------------ */

export type ProjectionParamType = "int" | "float" | "bool" | "choice" | "int_list";

/** Parameter values: scalars or an integer list (raw-axes selection). */
export type ProjectionParamValue = number | boolean | string | number[];

/** Declarative parameter spec — drives the projection form (single source
 *  of truth is the backend catalog; no hidden values). */
export interface ProjectionParamSpec {
  name: string;
  type: ProjectionParamType;
  default: ProjectionParamValue;
  description: string;
  min_value: number | null;
  max_value: number | null;
  step: number | null;
  choices: string[] | null;
  min_items: number | null;
  max_items: number | null;
}

export interface ProjectionMethodInfo {
  method_id: string;
  display_name: string;
  description: string;
  /** Honest interpretation caveat shown next to the method. */
  caveat: string;
  available: boolean;
  supported_components: number[];
  params: ProjectionParamSpec[];
}

export interface ComputeProjectionRequest {
  embedding_run_id: string;
  method: string;
  /** 3 = 3D scene, 2 = 2D map, 4 = 4D view (3D scene + "time" slider over
   *  the 4th axis); [3, 2] by default. Derived from `axes` for the raw_axes
   *  method (backend ignores the sent value then). */
  components: number[];
  params: Record<string, ProjectionParamValue>;
  seed: number;
  /** raw_axes only: several axis PAIRS in one job — one 2D projection per
   *  pair, compared side by side (2..6 sets; backend enforces). */
  axis_sets?: number[][] | null;
}

export interface ProjectionRunDTO {
  id: string;
  embedding_run_id: string;
  method: string;
  method_display_name: string;
  n_components: number;
  params: Record<string, ProjectionParamValue>;
  seed: number;
  axis_labels: string[];
  /** PCA: explained variance ratio per axis; raw_axes: per-axis std;
   *  UMAP: null. Meaning depends on the method — the UI labels it. */
  axis_info: number[] | null;
  count: number;
  /** Vectors changed since compute → the map is outdated, recompute. */
  stale: boolean;
  /** Coordinate cache readable; false → points endpoint 409s. */
  cache_ok: boolean;
  versions: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/** One point: display coordinates + full traceability to the source. */
export interface ProjectionPoint {
  fragment_id: string;
  file_id: string;
  rel_path: string;
  kind: string;
  name: string | null;
  symbol_path: string;
  start_line: number;
  end_line: number;
  coords: number[];
}

export interface ProjectionPoints {
  projection_id: string;
  method: string;
  method_display_name: string;
  n_components: number;
  axis_labels: string[];
  axis_info: number[] | null;
  stale: boolean;
  count: number;
  dropped_orphans: number;
  points: ProjectionPoint[];
}

/** Named projection form state (method + params + seed), project-scoped. */
export interface ProjectionPresetDTO {
  id: string;
  name: string;
  method: string;
  method_display_name: string;
  params: Record<string, ProjectionParamValue>;
  seed: number;
  created_at: string;
}

export interface CreatePresetRequest {
  name: string;
  method: string;
  params: Record<string, ProjectionParamValue>;
  seed: number;
}

/* ------------------------------------------------------------------ */
/* slices of the original space */
/* ------------------------------------------------------------------ */

export type SliceNormalKind = "axis" | "pca" | "vector";

export interface SliceNormal {
  kind: SliceNormalKind;
  index?: number | null;
  vector?: number[] | null;
}

export interface ComputeSliceRequest {
  embedding_run_id: string;
  normal: SliceNormal;
  position: number;
  thickness: number;
}

export interface SliceComputeResponse {
  embedding_run_id: string;
  normal_kind: SliceNormalKind;
  normal_index: number | null;
  dim: number;
  position: number;
  thickness: number;
  total: number;
  in_layer: number;
  u_min: number;
  u_max: number;
  /** Parallel arrays: signed coordinate along the normal per fragment. */
  ids: string[];
  u: number[];
  /** Honest interpretation note from the backend. */
  note: string;
}

export interface CreateSliceRequest {
  name: string;
  embedding_run_id: string;
  normal: SliceNormal;
  position: number;
  thickness: number;
}

export interface SavedSliceDTO {
  id: string;
  name: string;
  embedding_run_id: string;
  normal_kind: SliceNormalKind;
  normal_index: number | null;
  dim: number;
  vector: number[];
  position: number;
  thickness: number;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* semantic neighbors */
/* ------------------------------------------------------------------ */

export type NeighborMetric = "cosine" | "euclidean";

export interface NeighborsRequest {
  fragment_id: string;
  k: number;
  metric: NeighborMetric;
  embedding_run_id?: string | null;
}

export interface NeighborDTO {
  fragment_id: string;
  file_id: string;
  rel_path: string;
  kind: string;
  name: string | null;
  symbol_path: string;
  start_line: number;
  end_line: number;
  distance: number;
  score: number;
}

export interface NeighborsResponse {
  fragment_id: string;
  embedding_run_id: string;
  metric: NeighborMetric;
  k: number;
  total_vectors: number;
  neighbors: NeighborDTO[];
  note: string;
}

/* ------------------------------------------------------------------ */
/* structural relations */
/* ------------------------------------------------------------------ */

export type RelationOrigin = "extracted" | "imported" | "manual";

export interface RelationEndpointDTO {
  file_id: string | null;
  fragment_id: string | null;
  rel_path: string | null;
  name: string | null;
  symbol_path: string | null;
  start_line: number | null;
  end_line: number | null;
}

export interface RelationDTO {
  id: string;
  kind: string;
  origin: RelationOrigin;
  confidence: number | null;
  detail: string | null;
  created_at: string;
  source: RelationEndpointDTO;
  target: RelationEndpointDTO;
}

export interface RelationsResponse {
  items: RelationDTO[];
  total: number;
  limit: number;
  offset: number;
  counts_by_kind: Record<string, number>;
  counts_by_origin: Record<string, number>;
}

export interface CreateRelationRequest {
  source_fragment_id: string;
  target_fragment_id: string;
  kind: string;
  detail?: string | null;
}

export interface UnresolvedRelationDTO {
  index: number;
  kind: string;
  reason: string;
}

export interface ImportRelationsResponse {
  imported: number;
  duplicates: number;
  unresolved: UnresolvedRelationDTO[];
}

/* ------------------------------------------------------------------ */
/* clustering and manual groups */
/* ------------------------------------------------------------------ */

export type ClusteringSpace = "original" | "projection";
export type ClusteringMetric = "cosine" | "euclidean";

export interface ClusteringParamsDTO {
  eps: number;
  min_samples: number;
}

export interface ComputeClusteringRequest {
  embedding_run_id: string;
  space: ClusteringSpace;
  projection_run_id?: string | null;
  algorithm: "dbscan";
  metric?: ClusteringMetric | null;
  params?: ClusteringParamsDTO | null;
}

export interface ClusteringRunDTO {
  id: string;
  embedding_run_id: string;
  space: ClusteringSpace;
  projection_run_id: string | null;
  algorithm: string;
  metric: ClusteringMetric;
  params: ClusteringParamsDTO;
  count: number;
  n_clusters: number;
  noise: number;
  stale: boolean;
  cache_ok: boolean;
  versions: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface ClusteringLabelsDTO {
  clustering_id: string;
  space: ClusteringSpace;
  algorithm: string;
  metric: string;
  n_clusters: number;
  noise: number;
  count: number;
  ids: string[];
  labels: number[];
}

export interface CreateGroupRequest {
  name: string;
  fragment_ids: string[];
}

export interface FragmentGroupDTO {
  id: string;
  name: string;
  count: number;
  fragment_ids: string[];
  created_at: string;
}


// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

export interface MetricValueDTO {
  /** null = not computed (no data) — never a fake 0.0 */
  value: number | null;
  /** random-ranking null model (relation metrics): expected value by chance */
  baseline?: number | null;
  /** value / baseline (>1 — agreement better than chance) */
  lift?: number | null;
  k: number | null;
  n_sampled: number | null;
  n_sampled_with_relations: number | null;
  n_known_pairs_embedded: number | null;
  n_pairs_considered: number | null;
  explanation: string;
}

export interface MetricRunDTO {
  id: string;
  embedding_run_id: string;
  projection_run_id: string | null;
  k: number;
  sample_size: number;
  seed: number;
  relation_kinds: string[] | null;
  n_vectors: number;
  metrics: Record<string, MetricValueDTO>;
  /** relation metrics per relation kind over the SAME sample/top-k: the mixed
   *  value is dominated by trivial belongs_to pairs */
  per_kind?: Record<string, Record<string, MetricValueDTO>>;
  warnings: string[];
  stale: boolean;
  versions: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface ComputeMetricsRequest {
  embedding_run_id: string;
  /** null → only relation metrics (over the ORIGINAL space) */
  projection_run_id?: string | null;
  k: number;
  sample: number;
  seed: number;
  relation_kinds?: string[] | null;
}

// ---------------------------------------------------------------------------
// saved experiments
// ---------------------------------------------------------------------------

export type ViewModeId = "3d" | "2d" | "4d" | "split";
export type SliceDisplayId = "off" | "dim" | "only";

export interface ExperimentSliceDTO {
  saved_slice_id?: string | null;
  embedding_run_id?: string | null;
  normal_kind?: SliceNormalKind | null;
  normal_index?: number | null;
  normal_vector?: number[] | null;
  position?: number | null;
  thickness?: number | null;
}

export interface ExperimentProjectionsDTO {
  three?: string | null;
  two?: string[];
  four?: string | null;
}

export interface ExperimentConfigDTO {
  view_mode: ViewModeId;
  embedding_run_id: string | null;
  projections: ExperimentProjectionsDTO;
  slice: ExperimentSliceDTO | null;
  slice_display: SliceDisplayId;
  clustering_run_id: string | null;
  color_by: "kind" | "file" | "cluster";
  group_ids: string[];
  selection: string[];
  selection_truncated: boolean;
  metric_run_ids: string[];
}

export interface CreateExperimentRequest {
  name: string;
  description?: string | null;
  config: ExperimentConfigDTO;
}

export interface ExperimentSummaryDTO {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  /** short content summary built at save time (values are display-ready) */
  summary: Record<string, unknown>;
}

export interface ExperimentLiveStatusDTO {
  missing: Record<string, string[]>;
  stale: Record<string, string[]>;
}

export interface ExperimentDTO {
  id: string;
  name: string;
  description: string | null;
  config: ExperimentConfigDTO;
  /** interpretation context captured AT SAVE TIME (corpus, versions,
   *  staleness, metric values) */
  snapshot: Record<string, unknown>;
  live_status: ExperimentLiveStatusDTO | null;
  created_at: string;
}

/* ---------------------------------------------------------------------------
 * Research workspace (notebooks, notes, exports)
 * ------------------------------------------------------------------------- */

export type WorkspaceEntryKind = "dir" | "file";

export interface WorkspaceEntry {
  /** POSIX-style path relative to the project workspace root. */
  path: string;
  name: string;
  kind: WorkspaceEntryKind;
  size: number;
  mtime: number;
}

export interface WorkspaceTreeResponse {
  entries: WorkspaceEntry[];
  truncated: boolean;
  /** Absolute path for display/copy only — never sent back to the API. */
  root: string;
}

export interface WorkspaceFileContent {
  path: string;
  content: string;
  size: number;
  mtime: number;
}

export interface WorkspaceCreateRequest {
  path: string;
  content?: string;
  kind?: WorkspaceEntryKind;
}

export interface WorkspaceSaveRequest {
  path: string;
  content: string;
  base_mtime?: number | null;
  force?: boolean;
}

export interface OpenFolderResponse {
  opened: boolean;
  path: string;
  error?: string | null;
}

/* ---------------------------------------------------------------------------
 * Jupyter Notebooks and kernel sessions
 * ------------------------------------------------------------------------- */

export interface NotebookListItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

/** nbformat output objects are kept verbatim (unknown MIME types survive). */
export type CellOutput = Record<string, unknown> & {
  output_type: string;
};

export interface NotebookCellJson {
  cell_type: "code" | "markdown" | "raw";
  id?: string;
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: CellOutput[];
  execution_count?: number | null;
}

export interface NotebookJson {
  cells: NotebookCellJson[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

export interface NotebookContentResponse {
  path: string;
  notebook: NotebookJson;
  valid: boolean;
  problems: string[];
  mtime: number;
  size: number;
  ese_project_id: string | null;
}

export interface NotebookSaveResponse {
  path: string;
  mtime: number;
  size: number;
  valid: boolean;
  problems: string[];
}

export type KernelSessionState = "starting" | "ready" | "restarting" | "dead" | "error";

export interface KernelSessionDTO {
  session_id: string;
  project_id: string;
  path: string;
  state: KernelSessionState;
  error: string | null;
  busy: boolean;
  started_at: number;
  last_used: number;
}

export type ExecutionStatus = "running" | "done" | "error" | "interrupted" | "aborted";

export interface NotebookExecutionDTO {
  id: string;
  status: ExecutionStatus;
  outputs: CellOutput[];
  execution_count: number | null;
  error: string | null;
  truncated: boolean;
  started_at: number;
  finished_at: number | null;
}

export interface NotebookExecuteResponse {
  execution_id: string;
  status: string;
}

export interface EseApiEntry {
  name: string;
  kind: "function" | "method" | "property";
  owner: string | null;
  signature: string;
  doc: string;
}

export interface EseHelpContext {
  project_id: string;
  project_name: string;
  roots: string[];
  data_dir: string;
  project_dir: string;
  workspace_dir: string;
  notebooks_dir: string;
  notes_dir: string;
  results_dir: string;
  exports_dir: string;
  kernel_env: Record<string, string>;
}

export interface EseHelpResponse {
  context: EseHelpContext;
  quickstart: string;
  api: EseApiEntry[];
}
