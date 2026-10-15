/**
 * ProjectionControls tests: the form renders from the backend method catalog
 * (params are backend-declared, never hardcoded in the UI), the compute
 * request carries the exact form state, and view switching maps to
 * spaceStore.setActiveProjection.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EmbeddingRunDTO,
  JobInfo,
  ProjectionMethodInfo,
  ProjectionRunDTO,
} from "../../api/types";
import { mockFetch, mockResponse } from "../../testUtils";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";
import { ProjectionControls } from "./ProjectionControls";

const METHODS: ProjectionMethodInfo[] = [
  {
    method_id: "pca",
    display_name: "PCA",
    description: "Линейная проекция",
    caveat: "Оси принадлежат проекции",
    available: true,
    supported_components: [2, 3],
    params: [
      {
        name: "whiten",
        type: "bool",
        default: false,
        description: "Отбелить",
        min_value: null,
        max_value: null,
        step: null,
        choices: null,
      },
    ],
  },
  {
    method_id: "umap",
    display_name: "UMAP",
    description: "Нелинейная",
    caveat: "Расстояния искажены",
    available: true,
    supported_components: [2, 3],
    params: [
      {
        name: "n_neighbors",
        type: "int",
        default: 15,
        description: "Окрестность",
        min_value: 2,
        max_value: 500,
        step: 1,
        choices: null,
      },
      {
        name: "metric",
        type: "choice",
        default: "cosine",
        description: "Метрика",
        min_value: null,
        max_value: null,
        step: null,
        choices: ["cosine", "euclidean"],
      },
    ],
  },
];

const EMB_RUN: EmbeddingRunDTO = {
  id: "emb1",
  model_id: "m",
  model_display_name: "MiniLM",
  dim: 384,
  mode: "raw_fragment",
  template_preview: "",
  params: {},
  count: 21,
  coverage: { fragments_total: 21, embedded: 21, stale: 0, missing: 0 },
  created_at: "",
  updated_at: "2026-10-15T12:00:00+00:00",
};

const PROJ_3D: ProjectionRunDTO = {
  id: "proj3d",
  embedding_run_id: "emb1",
  method: "pca",
  method_display_name: "PCA",
  n_components: 3,
  params: {},
  seed: 42,
  axis_labels: ["PC1", "PC2", "PC3"],
  axis_info: null,
  count: 21,
  stale: true, // inventory label must carry staleness
  cache_ok: true,
  versions: {},
  created_at: "",
  updated_at: "2026-10-15T12:30:00+00:00",
};

const JOB: JobInfo = {
  id: "jobP",
  kind: "projection",
  state: "queued",
  progress_done: 0,
  progress_total: 0,
  message: null,
  error: null,
  warnings: [],
  created_at: "",
  started_at: null,
  finished_at: null,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  const { fetchMock } = mockFetch({
    "/api/projects/p1/embeddings": [EMB_RUN],
    "/api/projects/p1/projections": [PROJ_3D],
    "/api/projections/methods": METHODS,
  });
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.setState({ current: { id: "p1", name: "Sample" } as never });
  useExperimentStore.setState({
    runs: [EMB_RUN],
    projections: [PROJ_3D],
    projectionMethods: null,
    projRunId: null,
    projMethod: "pca",
    projParams: {},
    projSeed: 42,
    activeJob: null,
    error: null,
  });
  useSpaceStore.getState().reset();
});

afterEach(cleanup);

describe("ProjectionControls", () => {
  it("loads the method catalog on mount and seeds params from specs", async () => {
    render(<ProjectionControls />);
    await waitFor(() => {
      const s = useExperimentStore.getState();
      expect(s.projectionMethods).toHaveLength(2);
      expect(s.projParams).toEqual({ whiten: false }); // seeded from specs
    });
  });

  it("renders declared params only and switches them with the method", async () => {
    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projectionMethods).not.toBeNull());

    expect(screen.getByTitle("Отбелить")).toBeTruthy();

    const methodSelect = screen.getByTitle(
      "Метод проекции (параметры и seed сохраняются)",
    ).querySelector("select")!;
    fireEvent.change(methodSelect, { target: { value: "umap" } });

    await waitFor(() => {
      expect(useExperimentStore.getState().projParams).toEqual({
        n_neighbors: 15,
        metric: "cosine",
      });
    });
    expect(screen.getByTitle("Окрестность")).toBeTruthy();
    expect(screen.queryByTitle("Отбелить")).toBeNull();
    // metric is a choice → select with the declared options
    const metric = screen.getByTitle("Метрика").querySelector("select")!;
    expect(Array.from(metric.options).map((o) => o.value)).toEqual(["cosine", "euclidean"]);
  });

  it("compute posts the exact form state as one [3D+2D] job", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/embeddings": [EMB_RUN],
      "/api/projects/p1/projections": [PROJ_3D],
      "/api/projections/methods": METHODS,
      "POST /api/projects/p1/projections/compute": mockResponse(202, JOB),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().runs).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Построить проекцию/ }));
    await waitFor(() => expect(useExperimentStore.getState().activeJob?.id).toBe("jobP"));

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      embedding_run_id: "emb1",
      method: "pca",
      components: [3, 2],
      params: { whiten: false },
      seed: 42,
    });
  });

  it("3D-view select lists cached projections with honest staleness labels", async () => {
    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projections).not.toBeNull());

    const viewLabel = screen.getByTitle("Какую сохранённую проекцию показывает 3D-сцена");
    const select = viewLabel.querySelector("select")!;
    const optionText = Array.from(select.options)
      .map((o) => o.textContent)
      .join("|");
    expect(optionText).toContain("PCA · 3D · 21 точ. · seed 42 · УСТАРЕЛА");
  });

  it("switching a view activates that projection in the space store", async () => {
    const setActive = vi.spyOn(useSpaceStore.getState(), "setActiveProjection");
    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projections).not.toBeNull());

    const select = screen
      .getByTitle("Какую сохранённую проекцию показывает 3D-сцена")
      .querySelector("select")!;
    fireEvent.change(select, { target: { value: "proj3d" } });
    expect(setActive).toHaveBeenCalledWith("3d", "proj3d");
  });

  it("without embedding runs it explains the next step instead of failing silently", async () => {
    const { fetchMock } = mockFetch({
      "/api/projections/methods": METHODS,
    });
    vi.stubGlobal("fetch", fetchMock);
    useExperimentStore.setState({ runs: [], projections: [] });

    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projectionMethods).not.toBeNull());

    const computeBtn = screen.getByRole("button", { name: /Построить проекцию/ });
    expect((computeBtn as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Рассчитать эмбеддинги/ })).toBeTruthy();
  });
});
