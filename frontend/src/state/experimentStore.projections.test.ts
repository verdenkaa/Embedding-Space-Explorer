/**
 * experimentStore projection tests (stage 3): catalog with backend-declared
 * parameter specs (defaults seeded from the catalog — no hidden values),
 * compute request shape ([3, 2] components in one job), inventory refresh on
 * job completion and honest error mapping.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingRunDTO, JobInfo, ProjectionMethodInfo, ProjectionRunDTO } from "../api/types";
import { mockFetch, mockResponse } from "../testUtils";
import { useProjectStore } from "./projectStore";
import { defaultParamsFor, useExperimentStore } from "./experimentStore";

const PROJECT = { id: "p1", name: "Sample" } as never;

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
    description: "Нелинейная проекция",
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

const PROJECTION_RUN: ProjectionRunDTO = {
  id: "proj3d",
  embedding_run_id: "emb1",
  method: "pca",
  method_display_name: "PCA",
  n_components: 3,
  params: { whiten: false },
  seed: 42,
  axis_labels: ["PC1", "PC2", "PC3"],
  axis_info: [0.6, 0.3, 0.1],
  count: 21,
  stale: false,
  cache_ok: true,
  versions: { numpy: "2.4.6" },
  created_at: "",
  updated_at: "2026-10-15T12:30:00+00:00",
};

function jobInfo(state: JobInfo["state"], kind = "projection"): JobInfo {
  return {
    id: "jobP",
    kind,
    state,
    progress_done: 1,
    progress_total: 2,
    message: state,
    error: null,
    warnings: [],
    created_at: "",
    started_at: null,
    finished_at: null,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({ current: PROJECT });
  useExperimentStore.setState({
    runs: null,
    projectionMethods: null,
    projections: null,
    activeJob: null,
    projRunId: null,
    projMethod: "pca",
    projParams: {},
    projSeed: 42,
    error: null,
  });
});

describe("projection catalog & form", () => {
  it("loads the method catalog and seeds params from backend specs", async () => {
    const { fetchMock } = mockFetch({ "/api/projections/methods": METHODS });
    vi.stubGlobal("fetch", fetchMock);

    await useExperimentStore.getState().loadProjectionCatalog();
    const s = useExperimentStore.getState();
    expect(s.projectionMethods).toHaveLength(2);
    expect(s.projMethod).toBe("pca");
    expect(s.projParams).toEqual({ whiten: false });
  });

  it("switching method re-seeds that method's declared defaults", async () => {
    const { fetchMock } = mockFetch({ "/api/projections/methods": METHODS });
    vi.stubGlobal("fetch", fetchMock);
    await useExperimentStore.getState().loadProjectionCatalog();

    useExperimentStore.getState().setProjMethod("umap");
    const s = useExperimentStore.getState();
    expect(s.projMethod).toBe("umap");
    expect(s.projParams).toEqual({ n_neighbors: 15, metric: "cosine" });
  });

  it("defaultParamsFor builds values from specs only", () => {
    expect(defaultParamsFor(METHODS[1])).toEqual({ n_neighbors: 15, metric: "cosine" });
    expect(defaultParamsFor(null)).toEqual({});
  });

  it("clamps the seed into the accepted range", () => {
    useExperimentStore.getState().setProjSeed(-5);
    expect(useExperimentStore.getState().projSeed).toBe(0);
    useExperimentStore.getState().setProjSeed(9999999999999);
    expect(useExperimentStore.getState().projSeed).toBe(2147483647);
  });

  it("loadProjections stores the inventory", async () => {
    const { fetchMock } = mockFetch({ "/api/projects/p1/projections": [PROJECTION_RUN] });
    vi.stubGlobal("fetch", fetchMock);
    await useExperimentStore.getState().loadProjections();
    expect(useExperimentStore.getState().projections).toEqual([PROJECTION_RUN]);
  });
});

describe("startProjection", () => {
  it("posts the form with both display components in one job", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /projections/compute": mockResponse(202, jobInfo("queued")),
    });
    vi.stubGlobal("fetch", fetchMock);
    useExperimentStore.setState({
      runs: [EMB_RUN],
      projMethod: "umap",
      projParams: { n_neighbors: 7, metric: "euclidean" },
      projSeed: 11,
    });

    await useExperimentStore.getState().startProjection();
    expect(useExperimentStore.getState().activeJob?.id).toBe("jobP");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      embedding_run_id: "emb1", // newest run picked by default
      method: "umap",
      components: [3, 2],
      params: { n_neighbors: 7, metric: "euclidean" },
      seed: 11,
    });
  });

  it("explains honestly when there is nothing to project", async () => {
    const { fetchMock } = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    useExperimentStore.setState({ runs: [] });
    await useExperimentStore.getState().startProjection();
    const error = useExperimentStore.getState().error;
    expect(error?.code).toBe("no_embedding_run");
    expect(error?.hint).toContain("EXPERIMENTS");
  });

  it("maps backend conflicts (active job) with code and hint", async () => {
    const { fetchMock } = mockFetch({
      "POST /projections/compute": mockResponse(409, {
        error: { code: "projection_job_active", message: "busy", hint: "wait" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    useExperimentStore.setState({ runs: [EMB_RUN] });
    await useExperimentStore.getState().startProjection();
    expect(useExperimentStore.getState().error?.code).toBe("projection_job_active");
    expect(useExperimentStore.getState().activeJob).toBeNull();
  });

  it("tickActiveJob refreshes runs, catalog and projections on completion", async () => {
    let jobState: JobInfo = jobInfo("running");
    let projectionRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobs/jobP")) {
        return { ok: true, status: 200, json: async () => jobState } as unknown as Response;
      }
      if (url.endsWith("/projections")) {
        projectionRequests += 1;
        return {
          ok: true,
          status: 200,
          json: async () => [PROJECTION_RUN],
        } as unknown as Response;
      }
      if (url.endsWith("/embeddings")) {
        return { ok: true, status: 200, json: async () => [EMB_RUN] } as unknown as Response;
      }
      if (url.endsWith("/api/models")) {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      if (url.includes("preparation-preview")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ raw_fragment: "", context_enriched: "" }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    useExperimentStore.setState({ activeJob: jobInfo("running") });
    await useExperimentStore.getState().tickActiveJob();
    expect(projectionRequests).toBe(0); // not refreshed while running

    jobState = jobInfo("done");
    await useExperimentStore.getState().tickActiveJob();
    expect(useExperimentStore.getState().activeJob?.state).toBe("done");
    expect(projectionRequests).toBe(1);
    expect(useExperimentStore.getState().projections).toEqual([PROJECTION_RUN]);
  });
});
