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
  planned_stage: string | null;
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
/* Stage 1: projects, corpus, jobs                                     */
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
/* Stage 2: embeddings                                                 */
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
  coverage: CoverageDTO;
  created_at: string;
  updated_at: string;
}

export interface PreparationPreviews {
  raw_fragment: string;
  context_enriched: string;
}
