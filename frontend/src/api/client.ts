/**
 * Typed API client. Every panel talks to the backend only through this module
 * (TZ §10.2). Errors are normalized into ApiError with a machine-readable
 * code and a human-facing hint.
 */

import type {
  ChangesReport,
  CreateProjectRequest,
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
  /* health (stage 0) */
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

  /* filesystem browser (root picker) */
  listDirs: (path?: string): Promise<FsListResponse> =>
    request<FsListResponse>(
      `/api/fs/list-dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
};
