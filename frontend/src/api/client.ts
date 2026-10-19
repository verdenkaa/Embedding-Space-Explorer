/**
 * Typed API client. Every panel talks to the backend only through this module
 *. Errors are normalized into ApiError with a machine-readable
 * code and a human-facing hint.
 */

import type {
  ChangesReport,
  ClusteringLabelsDTO,
  ClusteringRunDTO,
  ComputeClusteringRequest,
  ComputeEmbeddingsRequest,
  ComputeMetricsRequest,
  ComputeProjectionRequest,
  ComputeSliceRequest,
  CreateGroupRequest,
  CreateProjectRequest,
  CreateExperimentRequest,
  CreateRelationRequest,
  CreateSliceRequest,
  EmbeddingRunDTO,
  ExperimentDTO,
  FragmentGroupDTO,
  ExperimentSummaryDTO,
  ImportRelationsResponse,
  MetricRunDTO,
  ModelInfo,
  NeighborMetric,
  NeighborsResponse,
  PreparationPreviews,
  CreatePresetRequest,
  ProjectionMethodInfo,
  ProjectionPoints,
  ProjectionPresetDTO,
  ProjectionRunDTO,
  FileContent,
  FileDetail,
  FileSummary,
  FragmentDetail,
  FragmentSearchResponse,
  FsListResponse,
  HealthResponse,
  JobInfo,
  LocateResponse,
  ProjectInfo,
  ProjectSummary,
  RelationDTO,
  RelationsResponse,
  SavedSliceDTO,
  SliceComputeResponse,
  StalenessReport,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; hint?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(
      0,
      "backend_unreachable",
      "Локальный backend недоступен (соединение отклонено).",
      "Запустите приложение скриптом scripts\\dev.bat (Windows) или ./scripts/dev.sh и дождитесь старта backend.",
    );
  }

  if (!response.ok) {
    let code = "http_error";
    let message = `Запрос завершился с HTTP ${response.status}`;
    let hint: string | undefined;
    try {
      const body = (await response.json()) as ErrorEnvelope;
      if (body.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        hint = body.error.hint ?? undefined;
      }
    } catch {
      // Non-JSON error body: keep the defaults above.
    }
    throw new ApiError(response.status, code, message, hint);
  }

  return (await response.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

export interface FragmentSearchParams {
  q?: string;
  kind?: string;
  file_id?: string;
  limit?: number;
  offset?: number;
}

export const api = {
  /* health */
  getHealth: (): Promise<HealthResponse> => request<HealthResponse>("/api/health"),

  /* projects */
  listProjects: (): Promise<ProjectSummary[]> => request<ProjectSummary[]>("/api/projects"),
  createProject: (payload: CreateProjectRequest): Promise<ProjectInfo> =>
    request<ProjectInfo>("/api/projects", jsonInit("POST", payload)),
  getProject: (pid: string): Promise<ProjectInfo> =>
    request<ProjectInfo>(`/api/projects/${pid}`),
  deleteProject: (pid: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}?confirm=true`, { method: "DELETE" }),
  getChanges: (pid: string): Promise<ChangesReport> =>
    request<ChangesReport>(`/api/projects/${pid}/changes`),
  getStaleness: (pid: string): Promise<StalenessReport> =>
    request<StalenessReport>(`/api/projects/${pid}/staleness`),
  startIndex: (pid: string): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/index`, { method: "POST" }),

  /* files & fragments */
  listFiles: (pid: string): Promise<FileSummary[]> =>
    request<FileSummary[]>(`/api/projects/${pid}/files`),
  getFile: (pid: string, fid: string): Promise<FileDetail> =>
    request<FileDetail>(`/api/projects/${pid}/files/${fid}`),
  getFileContent: (pid: string, fid: string): Promise<FileContent> =>
    request<FileContent>(`/api/projects/${pid}/files/${fid}/content`),
  locateFragments: (
    pid: string,
    fid: string,
    startLine: number,
    endLine: number,
  ): Promise<LocateResponse> =>
    request<LocateResponse>(
      `/api/projects/${pid}/files/${fid}/locate`,
      jsonInit("POST", { start_line: startLine, end_line: endLine }),
    ),
  searchFragments: (
    pid: string,
    params: FragmentSearchParams,
  ): Promise<FragmentSearchResponse> => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.kind) search.set("kind", params.kind);
    if (params.file_id) search.set("file_id", params.file_id);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    const qs = search.toString();
    return request<FragmentSearchResponse>(`/api/projects/${pid}/fragments${qs ? `?${qs}` : ""}`);
  },
  getFragment: (pid: string, fragmentId: string): Promise<FragmentDetail> =>
    request<FragmentDetail>(`/api/projects/${pid}/fragments/${fragmentId}`),

  /* jobs */
  listJobs: (pid: string): Promise<JobInfo[]> => request<JobInfo[]>(`/api/projects/${pid}/jobs`),
  getJob: (pid: string, jid: string): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/jobs/${jid}`),
  cancelJob: (pid: string, jid: string): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/jobs/${jid}/cancel`, { method: "POST" }),

  /* embeddings */
  listModels: (): Promise<ModelInfo[]> => request<ModelInfo[]>("/api/models"),
  getPreparationPreview: (): Promise<PreparationPreviews> =>
    request<PreparationPreviews>("/api/embeddings/preparation-preview"),
  downloadModel: (pid: string, modelId: string): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/models/download`, jsonInit("POST", { model_id: modelId })),
  computeEmbeddings: (pid: string, payload: ComputeEmbeddingsRequest): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/embeddings/compute`, jsonInit("POST", payload)),
  listEmbeddingRuns: (pid: string): Promise<EmbeddingRunDTO[]> =>
    request<EmbeddingRunDTO[]>(`/api/projects/${pid}/embeddings`),

  /* projections */
  listProjectionMethods: (): Promise<ProjectionMethodInfo[]> =>
    request<ProjectionMethodInfo[]>("/api/projections/methods"),
  computeProjection: (pid: string, payload: ComputeProjectionRequest): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/projections/compute`, jsonInit("POST", payload)),
  listProjections: (pid: string): Promise<ProjectionRunDTO[]> =>
    request<ProjectionRunDTO[]>(`/api/projects/${pid}/projections`),
  getProjectionPoints: (pid: string, projectionId: string): Promise<ProjectionPoints> =>
    request<ProjectionPoints>(`/api/projects/${pid}/projections/${projectionId}/points`),
  deleteProjection: (pid: string, projectionId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/projections/${projectionId}`, {
      method: "DELETE",
    }),
  deleteAllProjections: (pid: string): Promise<{ deleted: number }> =>
    request<{ deleted: number }>(`/api/projects/${pid}/projections?confirm=true`, {
      method: "DELETE",
    }),
  listPresets: (pid: string): Promise<ProjectionPresetDTO[]> =>
    request<ProjectionPresetDTO[]>(`/api/projects/${pid}/projection-presets`),
  createPreset: (pid: string, payload: CreatePresetRequest): Promise<ProjectionPresetDTO> =>
    request<ProjectionPresetDTO>(
      `/api/projects/${pid}/projection-presets`,
      jsonInit("POST", payload),
    ),
  deletePreset: (pid: string, presetId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/projection-presets/${presetId}`, {
      method: "DELETE",
    }),

  /* slices of the original space */
  computeSlice: (pid: string, payload: ComputeSliceRequest): Promise<SliceComputeResponse> =>
    request<SliceComputeResponse>(`/api/projects/${pid}/slices/compute`, jsonInit("POST", payload)),
  listSlices: (pid: string): Promise<SavedSliceDTO[]> =>
    request<SavedSliceDTO[]>(`/api/projects/${pid}/slices`),
  saveSlice: (pid: string, payload: CreateSliceRequest): Promise<SavedSliceDTO> =>
    request<SavedSliceDTO>(`/api/projects/${pid}/slices`, jsonInit("POST", payload)),
  deleteSlice: (pid: string, sliceId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/slices/${sliceId}`, { method: "DELETE" }),

  /* semantic neighbors */
  findNeighbors: (
    pid: string,
    fragmentId: string,
    k: number,
    metric: NeighborMetric,
    embeddingRunId?: string | null,
  ): Promise<NeighborsResponse> =>
    request<NeighborsResponse>(
      `/api/projects/${pid}/neighbors`,
      jsonInit("POST", {
        fragment_id: fragmentId,
        k,
        metric,
        ...(embeddingRunId ? { embedding_run_id: embeddingRunId } : {}),
      }),
    ),

  /* structural relations */
  listRelations: (
    pid: string,
    params: {
      fragment_id?: string;
      file_id?: string;
      kind?: string;
      origin?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<RelationsResponse> => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    }
    const qs = search.toString();
    return request<RelationsResponse>(`/api/projects/${pid}/relations${qs ? `?${qs}` : ""}`);
  },
  createRelation: (pid: string, payload: CreateRelationRequest): Promise<RelationDTO> =>
    request<RelationDTO>(`/api/projects/${pid}/relations`, jsonInit("POST", payload)),
  deleteRelation: (pid: string, relationId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/relations/${relationId}`, {
      method: "DELETE",
    }),
  importRelations: (pid: string, payload: unknown): Promise<ImportRelationsResponse> =>
    request<ImportRelationsResponse>(
      `/api/projects/${pid}/relations/import`,
      jsonInit("POST", payload),
    ),
  extractRelations: (pid: string): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/relations/extract`, { method: "POST" }),

  /* clustering + manual groups */
  computeClustering: (pid: string, payload: ComputeClusteringRequest): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/clustering/compute`, jsonInit("POST", payload)),
  listClustering: (pid: string): Promise<ClusteringRunDTO[]> =>
    request<ClusteringRunDTO[]>(`/api/projects/${pid}/clustering`),
  getClusteringLabels: (pid: string, clusteringId: string): Promise<ClusteringLabelsDTO> =>
    request<ClusteringLabelsDTO>(`/api/projects/${pid}/clustering/${clusteringId}/labels`),
  deleteClustering: (pid: string, clusteringId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/clustering/${clusteringId}`, {
      method: "DELETE",
    }),
  listGroups: (pid: string): Promise<FragmentGroupDTO[]> =>
    request<FragmentGroupDTO[]>(`/api/projects/${pid}/groups`),
  createGroup: (pid: string, payload: CreateGroupRequest): Promise<FragmentGroupDTO> =>
    request<FragmentGroupDTO>(`/api/projects/${pid}/groups`, jsonInit("POST", payload)),
  deleteGroup: (pid: string, groupId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/groups/${groupId}`, { method: "DELETE" }),

  /* metrics */
  computeMetrics: (pid: string, payload: ComputeMetricsRequest): Promise<JobInfo> =>
    request<JobInfo>(`/api/projects/${pid}/metrics/compute`, jsonInit("POST", payload)),
  listMetricRuns: (pid: string): Promise<MetricRunDTO[]> =>
    request<MetricRunDTO[]>(`/api/projects/${pid}/metrics`),
  getMetricRun: (pid: string, metricId: string): Promise<MetricRunDTO> =>
    request<MetricRunDTO>(`/api/projects/${pid}/metrics/${metricId}`),
  deleteMetricRun: (pid: string, metricId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/metrics/${metricId}`, {
      method: "DELETE",
    }),

  /* saved experiments */
  listExperiments: (pid: string): Promise<ExperimentSummaryDTO[]> =>
    request<ExperimentSummaryDTO[]>(`/api/projects/${pid}/experiments`),
  saveExperiment: (pid: string, payload: CreateExperimentRequest): Promise<ExperimentDTO> =>
    request<ExperimentDTO>(`/api/projects/${pid}/experiments`, jsonInit("POST", payload)),
  getExperiment: (pid: string, experimentId: string): Promise<ExperimentDTO> =>
    request<ExperimentDTO>(`/api/projects/${pid}/experiments/${experimentId}`),
  deleteExperiment: (pid: string, experimentId: string): Promise<{ deleted: string }> =>
    request<{ deleted: string }>(`/api/projects/${pid}/experiments/${experimentId}`, {
      method: "DELETE",
    }),

  /* filesystem browser (root picker) */
  listDirs: (path?: string): Promise<FsListResponse> =>
    request<FsListResponse>(
      `/api/fs/list-dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
};

/* ---------------------------------------------------------------------------
 * Export URL builders. Pure string helpers — the actual
 * download goes through downloadFromApi (blob + Content-Disposition).
 * ------------------------------------------------------------------------- */

export const exportUrls = {
  projectionPoints: (
    pid: string,
    projectionId: string,
    format: "csv" | "json" = "csv",
  ): string =>
    `/api/projects/${pid}/exports/projection/${projectionId}/points?format=${format}`,
  relations: (
    pid: string,
    filters: { kind?: string; origin?: string; fragmentId?: string } = {},
    format: "csv" | "json" = "csv",
  ): string => {
    const params = new URLSearchParams({ format });
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.origin) params.set("origin", filters.origin);
    if (filters.fragmentId) params.set("fragment_id", filters.fragmentId);
    return `/api/projects/${pid}/exports/relations?${params.toString()}`;
  },
  fragments: (pid: string): string => `/api/projects/${pid}/exports/fragments`,
  metricRun: (pid: string, metricId: string): string =>
    `/api/projects/${pid}/exports/metrics/${metricId}`,
  experiment: (pid: string, experimentId: string): string =>
    `/api/projects/${pid}/exports/experiments/${experimentId}`,
};
