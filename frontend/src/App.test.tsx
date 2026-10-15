/**
 * App-shell tests: diagnostics states (loading / online / offline), honest
 * disabled section tabs, the retry flow (TZ §12, §17.2), and a regression
 * test for the offline polling loop that once starved the event loop.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { HealthResponse } from "./api/types";
import { useUiStore } from "./state/uiStore";

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

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function stubFetchSuccess(): void {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(HEALTH_FIXTURE)));
}

function stubFetchNetworkError(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useUiStore.setState({ connection: "idle", health: null, error: null, lastCheckedAt: null });
});

// Vitest runs without globals, so RTL cannot auto-register cleanup.
afterEach(() => {
  cleanup();
});

describe("App shell", () => {
  it("shows backend diagnostics when health responds", async () => {
    stubFetchSuccess();
    render(<App />);

    // Wait for the online view via a unique checks entry.
    expect(await screen.findByText("data_dir_writable")).toBeTruthy();
    expect(screen.getByText("Проверки")).toBeTruthy();
    // Planned dependency reported honestly as not installed.
    expect(screen.getByText("не установлена")).toBeTruthy();
    expect(screen.getByText("stage-2")).toBeTruthy();
    expect(screen.getByLabelText(/backend онлайн/)).toBeTruthy();
  });

  it("shows a readable offline state with hint and retry button", async () => {
    stubFetchNetworkError();
    render(<App />);

    expect(await screen.findByText("Backend недоступен")).toBeTruthy();
    expect(screen.getByText(/Запустите приложение скриптом/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy();
    expect(screen.getByLabelText(/backend недоступен/)).toBeTruthy();
  });

  it("recovers via the retry button once backend comes up", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(jsonResponse(HEALTH_FIXTURE));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(await screen.findByText("Backend недоступен")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("data_dir_writable")).toBeTruthy();
    expect(screen.queryByText("Backend недоступен")).toBeNull();
  });

  it("keeps the event loop alive while offline (no retry storm)", async () => {
    // Regression: an effect that rescheduled polling on every connection
    // change created an infinite loading↔offline microtask loop when the
    // backend was down, starving timers and hammering the API.
    stubFetchNetworkError();
    render(<App />);
    expect(await screen.findByText("Backend недоступен")).toBeTruthy();

    // Timers must still fire while offline.
    const t0 = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);

    // Background polls must not flip the visible state to "loading".
    expect(useUiStore.getState().connection).toBe("offline");
  });

  it("renders future sections as visibly disabled with their stage", async () => {
    stubFetchSuccess();
    render(<App />);

    for (const [name, stage] of [
      ["SPACE", "этап 3"],
      ["CORPUS", "этап 1"],
      ["RELATIONS", "этап 4"],
      ["EXPERIMENTS", "этап 5"],
    ] as const) {
      const tab = screen.getByRole("button", { name: new RegExp(name) });
      expect((tab as HTMLButtonElement).disabled).toBe(true);
      expect(tab.textContent).toContain(stage);
    }
  });
});
