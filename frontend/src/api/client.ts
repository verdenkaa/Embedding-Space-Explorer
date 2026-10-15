/**
 * Typed API client. Every panel talks to the backend only through this module
 * (TZ §10.2). Errors are normalized into ApiError with a machine-readable
 * code and a human-facing hint.
 */

import type { ErrorResponse, HealthResponse } from "./types";

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
      const body = (await response.json()) as Partial<ErrorResponse>;
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

export const api = {
  getHealth: (): Promise<HealthResponse> => request<HealthResponse>("/api/health"),
};
