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

const RAW_AXES: ProjectionMethodInfo = {
  method_id: "raw_axes",
  display_name: "Сырые оси",
  description: "Оси исходного пространства",
  caveat: "Расстояния учитывают только выбранные оси",
  available: true,
  supported_components: [2, 3, 4],
  params: [
    {
      name: "axes",
      type: "int_list",
      default: [],
      description: "Индексы осей",
      min_value: null,
      max_value: null,
      step: null,
      choices: null,
      min_items: 2,
      max_items: 4,
    },
    {
      name: "standardize",
      type: "bool",
      default: false,
      description: "z-score",
      min_value: null,
      max_value: null,
      step: null,
      choices: null,
      min_items: null,
      max_items: null,
    },
  ],
};

const METHODS_BASE: ProjectionMethodInfo[] = [
  {
    method_id: "pca",
    display_name: "PCA",
    description: "Линейная проекция",
    caveat: "Оси принадлежат проекции",
    available: true,
    supported_components: [2, 3, 4],
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
        min_items: null,
        max_items: null,
      },
    ],
  },
  {
    method_id: "umap",
    display_name: "UMAP",
    description: "Нелинейная",
    caveat: "Расстояния искажены",
    available: true,
    supported_components: [2, 3, 4],
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
        min_items: null,
        max_items: null,
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
        min_items: null,
        max_items: null,
      },
    ],
  },
];
const METHODS = [...METHODS_BASE, RAW_AXES];

const PRESET = {
  id: "pre1",
  name: "Оси 0/3",
  method: "raw_axes",
  method_display_name: "Сырые оси",
  params: { axes: [0, 3], standardize: true },
  seed: 7,
  created_at: "",
};

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
    "/api/projects/p1/projection-presets": [PRESET],
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
    projAxesGroups: [],
    projAxesProblem: null,
    pendingBuild: null,
    presets: null,
    presetName: "",
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
      expect(s.projectionMethods).toHaveLength(3);
      expect(s.projParams).toEqual({ whiten: false }); // seeded from specs
    });
  });

  it("renders declared params only and switches them with the method", async () => {
    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projectionMethods).not.toBeNull());

    expect(screen.getByLabelText("whiten")).toBeTruthy();

    const methodSelect = screen.getByLabelText("Метод проекции");
    fireEvent.change(methodSelect, { target: { value: "umap" } });

    await waitFor(() => {
      expect(useExperimentStore.getState().projParams).toEqual({
        n_neighbors: 15,
        metric: "cosine",
      });
    });
    expect(screen.getByLabelText("n_neighbors")).toBeTruthy();
    expect(screen.queryByLabelText("whiten")).toBeNull();
    // metric is a choice → select with the declared options
    const metric = screen.getByLabelText("metric") as HTMLSelectElement;
    expect(Array.from(metric.options).map((o) => o.value)).toEqual(["cosine", "euclidean"]);
  });

  it("compute posts the exact form state as one [3D+2D] job", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/embeddings": [EMB_RUN],
      "/api/projects/p1/projections": [PROJ_3D],
      "/api/projects/p1/projection-presets": [PRESET],
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

  it("PCA/UMAP get an explicit 4D build (components [4]) next to 3D+2D", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/embeddings": [EMB_RUN],
      "/api/projects/p1/projections": [PROJ_3D],
      "/api/projects/p1/projection-presets": [PRESET],
      "/api/projections/methods": METHODS,
      "POST /api/projects/p1/projections/compute": mockResponse(202, JOB),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projectionMethods).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Построить 4D" }));
    await waitFor(() => expect(useExperimentStore.getState().activeJob?.id).toBe("jobP"));
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/compute"));
    expect(post?.body).toMatchObject({ method: "pca", components: [4] });
    expect(useExperimentStore.getState().pendingBuild).toEqual({
      mode: "single",
      components: [4],
      embeddingRunId: "emb1",
    });
  });

  it("raw_axes: axes field validates inline and drives the build request", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/embeddings": [EMB_RUN],
      "/api/projects/p1/projections": [],
      "/api/projects/p1/projection-presets": [],
      "/api/projections/methods": METHODS,
      "POST /api/projects/p1/projections/compute": mockResponse(202, JOB),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projectionMethods).not.toBeNull());

    fireEvent.change(screen.getByLabelText("Метод проекции"), { target: { value: "raw_axes" } });
    const axesInput = await screen.findByLabelText("axes");
    // build is disabled until 2-3 valid axes are entered
    const build = screen.getByRole("button", { name: /Построить проекцию/ });
    expect((build as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(axesInput, { target: { value: "12, x" } });
    expect(screen.getByText(/только целые/)).toBeTruthy();

    fireEvent.change(axesInput, { target: { value: "12, 57, 200" } });
    await waitFor(() =>
      expect(useExperimentStore.getState().projParams["axes"]).toEqual([12, 57, 200]),
    );
    // dim of the selected run is 384 → index 400 is out of range
    fireEvent.change(axesInput, { target: { value: "12, 400" } });
    expect(screen.getByText(/вне диапазона 0..383/)).toBeTruthy();

    fireEvent.change(axesInput, { target: { value: "12, 57, 200" } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /Построить проекцию/ }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByRole("button", { name: "Построить проекцию (3D)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Построить проекцию/ }));
    await waitFor(() => expect(useExperimentStore.getState().activeJob?.id).toBe("jobP"));
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/compute"));
    expect(post?.body).toMatchObject({
      method: "raw_axes",
      components: [3], // derived from the axes count — never [3,2]
      params: { axes: [12, 57, 200], standardize: false },
    });

    // four axes → the 4D view (first three = scene, fourth = "time")
    fireEvent.change(axesInput, { target: { value: "12, 57, 200, 300" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Построить проекцию (4D)" })).toBeTruthy(),
    );
  });

  it("raw_axes multi: «0,1;0,2» builds one 2D projection per pair", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/embeddings": [EMB_RUN],
      "/api/projects/p1/projections": [],
      "/api/projects/p1/projection-presets": [],
      "/api/projections/methods": METHODS,
      "POST /api/projects/p1/projections/compute": mockResponse(202, JOB),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projectionMethods).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Метод проекции"), { target: { value: "raw_axes" } });
    const axesInput = await screen.findByLabelText("axes");

    fireEvent.change(axesInput, { target: { value: "0,1;0,2" } });
    await waitFor(() =>
      expect(useExperimentStore.getState().projAxesGroups).toEqual([
        [0, 1],
        [0, 2],
      ]),
    );
    const build = screen.getByRole("button", { name: "Построить графики (2D×2)" });
    expect((build as HTMLButtonElement).disabled).toBe(false);
    // a preset saves ONE combination — saving is honestly disabled in multi mode
    fireEvent.change(screen.getByLabelText("Имя нового пресета"), {
      target: { value: "пара" },
    });
    expect(
      (screen.getByRole("button", { name: "Сохранить пресет" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(build);
    await waitFor(() => expect(useExperimentStore.getState().activeJob?.id).toBe("jobP"));
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/compute"));
    expect(post?.body).toEqual({
      embedding_run_id: "emb1",
      method: "raw_axes",
      components: [2],
      params: { standardize: false }, // axes travel inside axis_sets only
      seed: 42,
      axis_sets: [
        [0, 1],
        [0, 2],
      ],
    });
    expect(useExperimentStore.getState().pendingBuild).toEqual({
      mode: "multi2d",
      sets: [
        [0, 1],
        [0, 2],
      ],
      embeddingRunId: "emb1",
      seed: 42,
      standardize: false,
    });
  });

  it("raw_axes multi: invalid groups block the build with an inline reason", async () => {
    render(<ProjectionControls />);
    await waitFor(() => expect(useExperimentStore.getState().projectionMethods).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Метод проекции"), { target: { value: "raw_axes" } });
    const axesInput = await screen.findByLabelText("axes");

    fireEvent.change(axesInput, { target: { value: "0,1;0,2;0,3;1,2;1,3;2,3;0,4" } });
    expect(screen.getByText(/не больше 6 групп/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Построить/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.change(axesInput, { target: { value: "0,1,2;0,3" } });
    expect(screen.getByText(/ровно 2 оси/)).toBeTruthy();

    fireEvent.change(axesInput, { target: { value: "0,1;0,1" } });
    expect(screen.getByText(/группы не должны повторяться/)).toBeTruthy();
  });

  it("presets: apply fills the form, save posts the current state, delete removes", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/embeddings": [EMB_RUN],
      "/api/projects/p1/projections": [],
      "/api/projects/p1/projection-presets": [PRESET],
      "/api/projections/methods": METHODS,
      "POST /api/projects/p1/projection-presets": mockResponse(201, PRESET),
      "DELETE /api/projects/p1/projection-presets/pre1": { deleted: "pre1" },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectionControls />);
    const presetSelect = (await screen.findByLabelText(
      "Сохранённые пресеты проекций",
    )) as HTMLSelectElement;
    expect(Array.from(presetSelect.options).some((o) => o.textContent?.includes("Оси 0/3"))).toBe(
      true,
    );

    // applying the preset switches method/params/seed
    fireEvent.change(presetSelect, { target: { value: "pre1" } });
    await waitFor(() => {
      const s = useExperimentStore.getState();
      expect(s.projMethod).toBe("raw_axes");
      expect(s.projParams).toEqual({ axes: [0, 3], standardize: true });
      expect(s.projSeed).toBe(7);
    });

    // the matching preset can be deleted right from the panel
    fireEvent.click(screen.getByRole("button", { name: /Удалить пресет «Оси 0\/3»/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/pre1"))).toBe(true),
    );

    // saving: name + POST body from the form
    fireEvent.change(screen.getByLabelText("Имя нового пресета"), {
      target: { value: "Мой пресет" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить пресет" }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/projection-presets"),
      );
      expect(post?.body).toEqual({
        name: "Мой пресет",
        method: "raw_axes",
        params: { axes: [0, 3], standardize: true },
        seed: 7,
      });
    });
  });

  it("without embedding runs it explains the next step instead of failing silently", async () => {
    const { fetchMock } = mockFetch({
      "/api/projections/methods": METHODS,
      "/api/projects/p1/projection-presets": [],
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
