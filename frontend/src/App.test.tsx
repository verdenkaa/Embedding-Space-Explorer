/**
 * App-shell tests: section switching, diagnostics states (loading / online /
 * offline), honest section tabs, the retry flow (TZ §12, §17.2), and a
 * regression test for the offline polling loop that once starved the event
 * loop.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import type { HealthResponse, ProjectSummary } from "./api/types";
import { useUiStore } from "./state/uiStore";
import { useProjectStore } from "./state/projectStore";
import { mockFetch, mockReject } from "./testUtils";

const HEALTH_FIXTURE: HealthResponse = {
  status: "ok",
  app_name: "embedding-space-explorer",
  app_version: "0.3.0",
  schema_version: 3,
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

const NO_PROJECTS: ProjectSummary[] = [];

function stubOnline(): void {
  const { fetchMock } = mockFetch({
    "/api/health": HEALTH_FIXTURE,
    "/api/projects": NO_PROJECTS,
  });
  vi.stubGlobal("fetch", fetchMock);
}

function stubOffline(): void {
  const { fetchMock } = mockFetch({
    "/api/health": mockReject(new TypeError("Failed to fetch")),
    "/api/projects": mockReject(new TypeError("Failed to fetch")),
  });
  vi.stubGlobal("fetch", fetchMock);
}

function openDiagnostics(): void {
  fireEvent.click(screen.getByRole("button", { name: "Диагностика" }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useUiStore.setState({
    connection: "idle",
    health: null,
    error: null,
    lastCheckedAt: null,
    activeSection: "space",
  });
  useProjectStore.setState({ current: null, projects: null, error: null });
});

afterEach(() => {
  cleanup();
});

describe("App shell", () => {
  it("shows the start screen by default (no project open)", async () => {
    stubOnline();
    render(<App />);
    expect(await screen.findByText("Начало работы")).toBeTruthy();
    expect(await screen.findByLabelText(/backend онлайн/)).toBeTruthy();
  });

  it("opens diagnostics via the top-bar button and shows health", async () => {
    stubOnline();
    render(<App />);
    expect(await screen.findByText("Начало работы")).toBeTruthy();

    openDiagnostics();
    expect(await screen.findByText("data_dir_writable")).toBeTruthy();
    expect(screen.getByText("Проверки")).toBeTruthy();
    expect(screen.getByText("не установлена")).toBeTruthy();
    expect(screen.getByText("stage-2")).toBeTruthy();
  });

  it("shows a readable offline state with hint and retry button", async () => {
    stubOffline();
    render(<App />);
    openDiagnostics();

    expect(await screen.findByText("Backend недоступен")).toBeTruthy();
    expect(screen.getByText(/Запустите приложение скриптом/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeTruthy();
    expect(screen.getByLabelText(/backend недоступен/)).toBeTruthy();
  });

  it("recovers via the retry button once backend comes up", async () => {
    stubOffline();
    render(<App />);
    openDiagnostics();
    expect(await screen.findByText("Backend недоступен")).toBeTruthy();

    stubOnline();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("data_dir_writable")).toBeTruthy();
    expect(screen.queryByText("Backend недоступен")).toBeNull();
  });

  it("keeps the event loop alive while offline (no retry storm)", async () => {
    // Regression: an effect that rescheduled polling on every connection
    // change created an infinite loading↔offline microtask loop when the
    // backend was down, starving timers and hammering the API.
    stubOffline();
    render(<App />);
    openDiagnostics();
    expect(await screen.findByText("Backend недоступен")).toBeTruthy();

    const t0 = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);

    expect(useUiStore.getState().connection).toBe("offline");
  });

  it("SPACE, RELATIONS and EXPERIMENTS are available; CORPUS is gone (merged into SPACE)", async () => {
    stubOnline();
    render(<App />);

    for (const name of ["SPACE", "RELATIONS", "EXPERIMENTS"]) {
      const tab = screen.getByRole("button", { name: new RegExp(name) });
      expect((tab as HTMLButtonElement).disabled).toBe(false);
    }

    // the CORPUS tab was removed: everything it showed lives inside SPACE
    expect(screen.queryByRole("button", { name: /CORPUS/ })).toBeNull();
  });
});
