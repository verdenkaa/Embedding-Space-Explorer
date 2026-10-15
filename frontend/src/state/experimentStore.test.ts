/**
 * experimentStore tests: catalog loading, default model selection, compute
 * job lifecycle with refresh on completion, honest error mapping.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingRunDTO, JobInfo, ModelInfo, PreparationPreviews } from "../api/types";
import { mockFetch, mockReject, mockResponse } from "../testUtils";
import { useProjectStore } from "./projectStore";
import { useExperimentStore } from "./experimentStore";

const MODELS: ModelInfo[] = [
  {
    model_id: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    display_name: "paraphrase-multilingual-MiniLM-L12-v2",
    dim: 384,
    approx_download_mb: 470,
    description: "Мультиязычная модель",
    is_default: true,
    downloaded: true,
  },
  {
    model_id: "sentence-transformers/all-MiniLM-L6-v2",
    display_name: "all-MiniLM-L6-v2",
    dim: 384,
    approx_download_mb: 90,
    description: "Компактная модель",
    is_default: false,
    downloaded: false,
  },
];

const PREVIEWS: PreparationPreviews = {
  raw_fragment: "<только текст фрагмента, без метаданных>",
  context_enriched: "# path: src/app.py\n# symbol: f\n...",
};

const RUN: EmbeddingRunDTO = {
  id: "fp123",
  model_id: MODELS[0].model_id,
  model_display_name: MODELS[0].display_name,
  dim: 384,
  mode: "raw_fragment",
  template_preview: PREVIEWS.raw_fragment,
  params: { batch_size: 16, normalize: true, device: "cpu" },
  count: 21,
  coverage: { fragments_total: 21, embedded: 21, stale: 0, missing: 0 },
  created_at: "",
  updated_at: "2026-10-15T12:00:00+00:00",
};

const PROJECT = { id: "p1", name: "Sample" } as never;

function jobInfo(state: JobInfo["state"], kind = "embed"): JobInfo {
  return {
    id: "jobE",
    kind,
    state,
    progress_done: state === "done" ? 21 : 5,
    progress_total: 21,
    message: state,
    error: null,
    warnings: [],
    created_at: "",
    started_at: null,
    finished_at: null,
  };
}

function resetStores() {
  useProjectStore.setState({ current: PROJECT, activeJob: null, error: null });
  useExperimentStore.setState({
    models: null,
    previews: null,
    runs: null,
    activeJob: null,
    modelId: null,
    mode: "raw_fragment",
    batchSize: 16,
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetStores();
});

describe("experimentStore", () => {
  it("loads catalog + previews and selects the default model", async () => {
    const { fetchMock } = mockFetch({
      "/api/embeddings/preparation-preview": PREVIEWS,
      "/api/models": MODELS,
    });
    vi.stubGlobal("fetch", fetchMock);

    await useExperimentStore.getState().loadCatalog();
    const state = useExperimentStore.getState();
    expect(state.models).toHaveLength(2);
    expect(state.modelId).toBe(MODELS[0].model_id);
    expect(state.previews?.context_enriched).toContain("# path:");
  });

  it("startCompute posts the form and stores the job", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /embeddings/compute": mockResponse(202, jobInfo("queued")),
    });
    vi.stubGlobal("fetch", fetchMock);
    useExperimentStore.setState({ modelId: MODELS[0].model_id, mode: "context_enriched", batchSize: 8 });

    await useExperimentStore.getState().startCompute();
    expect(useExperimentStore.getState().activeJob?.id).toBe("jobE");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      model_id: MODELS[0].model_id,
      mode: "context_enriched",
      batch_size: 8,
    });
  });

  it("tickActiveJob refreshes runs and catalog on completion", async () => {
    let jobState: JobInfo = jobInfo("running");
    let runsRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobs/jobE")) {
        return { ok: true, status: 200, json: async () => jobState } as unknown as Response;
      }
      if (url.endsWith("/embeddings")) {
        runsRequests += 1;
        return { ok: true, status: 200, json: async () => [RUN] } as unknown as Response;
      }
      if (url.endsWith("/api/models")) {
        return { ok: true, status: 200, json: async () => MODELS } as unknown as Response;
      }
      if (url.includes("preparation-preview")) {
        return { ok: true, status: 200, json: async () => PREVIEWS } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    useExperimentStore.setState({ activeJob: jobInfo("running") });
    await useExperimentStore.getState().tickActiveJob();
    expect(useExperimentStore.getState().activeJob?.state).toBe("running");
    expect(runsRequests).toBe(0); // not refreshed while running

    jobState = jobInfo("done");
    await useExperimentStore.getState().tickActiveJob();
    expect(useExperimentStore.getState().activeJob?.state).toBe("done");
    expect(runsRequests).toBe(1);
    expect(useExperimentStore.getState().runs).toEqual([RUN]);
  });

  it("maps API errors with code and hint (e.g. model not downloaded)", async () => {
    const { fetchMock } = mockFetch({
      "POST /models/download": mockResponse(409, {
        error: { code: "embedding_job_active", message: "busy", hint: "wait" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await useExperimentStore.getState().startDownload(MODELS[1].model_id);
    const error = useExperimentStore.getState().error;
    expect(error?.code).toBe("embedding_job_active");
    expect(error?.hint).toBe("wait");
  });

  it("survives backend outage without crashing", async () => {
    const { fetchMock } = mockFetch({
      "/api/models": mockReject(new TypeError("Failed to fetch")),
      "/api/embeddings/preparation-preview": mockReject(new TypeError("Failed to fetch")),
    });
    vi.stubGlobal("fetch", fetchMock);
    await useExperimentStore.getState().loadCatalog();
    expect(useExperimentStore.getState().error?.code).toBe("backend_unreachable");
  });
});
