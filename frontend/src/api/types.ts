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
