/**
 * SavedExperimentsCard tests: the list with save-time summaries,
 * the save flow (explicit name required), the open report (what was restored
 * and what was honestly skipped) and the two-way comparison table.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExperimentDTO, ExperimentSummaryDTO } from "../../api/types";
import { useProjectStore } from "../../state/projectStore";
import { useSavedExperimentsStore } from "../../state/savedExperimentsStore";
import { useSpaceStore } from "../../state/spaceStore";
import { mockFetch, mockResponse, type RecordedCall } from "../../testUtils";
import { SavedExperimentsCard } from "./SavedExperimentsCard";

const SUMMARY_A: ExperimentSummaryDTO = {
  id: "e1",
  name: "baseline",
  description: "PCA split",
  created_at: "2026-10-16T10:00:00+00:00",
  summary: {
    view_mode: "split",
    projections: { three: "p3xxxxxx", four: null, two_count: 1 },
    slice: false,
    groups: 0,
    selection: 0,
    metric_values: { neighbor_retention: 0.42 },
  },
};

const SUMMARY_B: ExperimentSummaryDTO = {
  id: "e2",
  name: "umap-run",
  description: null,
  created_at: "2026-10-16T11:00:00+00:00",
  summary: { view_mode: "3d", projections: { three: null, four: null, two_count: 0 } },
};

function dto(id: string, name: string, viewMode: "3d" | "split"): ExperimentDTO {
  return {
    id,
    name,
    description: null,
    created_at: "2026-10-16T10:00:00+00:00",
    config: {
      view_mode: viewMode,
      embedding_run_id: null,
      projections: { three: null, two: [], four: null },
      slice: null,
      slice_display: "off",
      clustering_run_id: null,
      color_by: "kind",
      group_ids: [],
      selection: viewMode === "split" ? ["f1"] : [],
      selection_truncated: false,
      metric_run_ids: [],
    },
    snapshot: { app_version: "0.8.0" },
    live_status: { missing: {}, stale: {} },
  };
}

let fetchCalls: RecordedCall[] = [];

beforeEach(() => {
  vi.unstubAllGlobals();
  const { fetchMock, calls } = mockFetch({
    "/api/projects/p1/experiments/e1": dto("e1", "baseline", "split"),
    "/api/projects/p1/experiments/e2": dto("e2", "umap-run", "3d"),
    "POST /api/projects/p1/experiments": mockResponse(201, dto("e1", "baseline", "split")),
    "/api/projects/p1/experiments": [SUMMARY_A, SUMMARY_B],
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchCalls = calls;
  useProjectStore.setState({ current: { id: "p1", name: "Sample" } as never, selectedFragmentIds: [] });
  useSpaceStore.getState().reset();
  useSavedExperimentsStore.setState({
    experiments: null,
    loading: false,
    error: null,
    lastOpenReport: null,
  });
});

afterEach(cleanup);

describe("SavedExperimentsCard", () => {
  it("lists experiments with save-time summary chips", async () => {
    render(<SavedExperimentsCard />);
    await waitFor(() => expect(screen.getByText("baseline")).toBeTruthy());
    expect(screen.getByText("umap-run")).toBeTruthy();
    expect(screen.getByText("вид: split")).toBeTruthy();
    expect(screen.getByText("neighbor_retention: 0.420")).toBeTruthy();
    expect(screen.getByText("проекции: —")).toBeTruthy(); // umap-run has none
  });

  it("save requires a name and posts the captured state", async () => {
    render(<SavedExperimentsCard />);
    await waitFor(() => expect(screen.getByText("baseline")).toBeTruthy());

    const save = screen.getByRole("button", { name: "Сохранить текущее состояние" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    useSpaceStore.setState({ viewMode: "4d" });
    fireEvent.change(screen.getByLabelText("Имя эксперимента"), { target: { value: " run42 " } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(fetchCalls.some((c) => c.method === "POST" && c.url.includes("/experiments"))).toBe(true),
    );
    const post = fetchCalls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ name: "run42", config: { view_mode: "4d" } });
  });

  it("«Открыть» restores the selection and shows the honest report", async () => {
    render(<SavedExperimentsCard />);
    await waitFor(() => expect(screen.getByText("baseline")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: "Открыть" })[0]);
    await waitFor(() => expect(screen.getByText("Отчёт открытия")).toBeTruthy());
    expect(screen.getByText(/Восстановлено: .*выделение \(1\)/)).toBeTruthy();
    expect(useProjectStore.getState().selectedFragmentIds).toEqual(["f1"]);
    expect(useSpaceStore.getState().viewMode).toBe("split");
  });

  it("compare puts two snapshots side by side", async () => {
    render(<SavedExperimentsCard />);
    await waitFor(() => expect(screen.getByText("baseline")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Сравнить «baseline»"));
    fireEvent.click(screen.getByLabelText("Сравнить «umap-run»"));
    fireEvent.click(screen.getByRole("button", { name: /Сравнить отмеченные \(2\/2\)/ }));

    await waitFor(() => expect(screen.getByLabelText("Сравнение экспериментов")).toBeTruthy());
    // the comparison table shows both names as columns and the view row
    const cells = screen.getAllByRole("cell").map((c) => c.textContent);
    expect(cells).toContain("split");
    expect(cells).toContain("3d");
    expect(screen.getByText("Вид")).toBeTruthy();
    expect(screen.getByText("Версия приложения")).toBeTruthy();
  });

  it("delete is a two-step confirmation (destructive → confirm)", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/experiments": [SUMMARY_A],
      "DELETE /api/projects/p1/experiments/e1": { deleted: "e1" },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SavedExperimentsCard />);
    await waitFor(() => expect(screen.getByText("baseline")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    // nothing deleted yet — the confirmation is armed, then disarmed
    fireEvent.click(screen.getByRole("button", { name: "Нет" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить?" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});
