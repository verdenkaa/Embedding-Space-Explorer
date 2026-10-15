/**
 * Tests for the typed API client error mapping.
 * jsdom has no fetch; the client is exercised with a stubbed global fetch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "./client";
import type { HealthResponse } from "./types";

const HEALTH_FIXTURE: HealthResponse = {
  status: "ok",
  app_name: "embedding-space-explorer",
  app_version: "0.1.0",
  schema_version: 1,
  python_version: "3.12.7",
  platform: "Windows-11-10.0.26100-SP0",
  server_host: "127.0.0.1",
  server_port: 8000,
  loopback_only: true,
  data_dir: "C:\\Users\\dev\\.embedding-space-explorer",
  dependencies: [
    { name: "fastapi", installed: true, version: "0.143.1", required: true, planned_stage: null },
    { name: "torch", installed: false, version: null, required: false, planned_stage: "stage-2" },
  ],
  checks: [
    { name: "data_dir_writable", status: "ok", detail: "C:\\Users\\dev\\.ese" },
    { name: "loopback_binding", status: "ok", detail: "listening on 127.0.0.1 only" },
  ],
};

interface FakeResponseInit {
  ok: boolean;
  status: number;
  body: unknown;
  jsonFails?: boolean;
}

function fakeResponse(init: FakeResponseInit): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => {
      if (init.jsonFails) {
        throw new Error("not json");
      }
      return init.body;
    },
  } as unknown as Response;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("api.getHealth", () => {
  it("returns parsed health payload on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse({ ok: true, status: 200, body: HEALTH_FIXTURE })),
    );

    const health = await api.getHealth();
    expect(health.status).toBe("ok");
    expect(health.app_version).toBe("0.1.0");
    expect(health.loopback_only).toBe(true);
    expect(health.dependencies).toHaveLength(2);
  });

  it("maps a network failure to backend_unreachable with a hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const error = await api.getHealth().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(0);
    expect(apiError.code).toBe("backend_unreachable");
    expect(apiError.hint).toBeTruthy();
  });

  it("preserves the structured error envelope from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          ok: false,
          status: 403,
          body: {
            error: {
              code: "forbidden_host",
              message: "Host 'evil.example' is not allowed",
              hint: "Use 127.0.0.1",
            },
          },
        }),
      ),
    );

    const error = (await api.getHealth().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden_host");
    expect(error.message).toBe("Host 'evil.example' is not allowed");
    expect(error.hint).toBe("Use 127.0.0.1");
  });

  it("falls back to a generic message for non-JSON error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({ ok: false, status: 500, body: null, jsonFails: true }),
      ),
    );

    const error = (await api.getHealth().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(500);
    expect(error.code).toBe("http_error");
    expect(error.message).toContain("500");
  });
});
