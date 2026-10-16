/**
 * analysisStore tests (stage 4): neighbors/relations loading, the relations
 * extraction job channel, import reports, clustering start + applying labels
 * to the scene (explicit user action), groups, and the slice overlay
 * lifecycle (server u-array → client-side window defaults).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ClusteringLabelsDTO,
  ClusteringRunDTO,
  JobInfo,
  NeighborsResponse,
  RelationsResponse,
  SavedSliceDTO,
} from "../api/types";
import { mockFetch, mockResponse } from "../testUtils";
import { useAnalysisStore } from "./analysisStore";
import { useProjectStore } from "./projectStore";
import { useSpaceStore } from "./spaceStore";

const PROJECT = { id: "p1", name: "Sample" } as never;

const NEIGHBORS: NeighborsResponse = {
  fragment_id: "fragA",
  embedding_run_id: "emb1",
  metric: "cosine",
  k: 5,
  total_vectors: 21,
  neighbors: [
    {
      fragment_id: "fragB",
      file_id: "fb",
      rel_path: "src/b.py",
      kind: "class",
      name: "B",
      symbol_path: "B",
      start_line: 3,
      end_line: 8,
      distance: 0.2,
      score: 0.8,
    },
  ],
  note: "по ИСХОДНЫМ эмбеддингам (метрика cosine)",
};

const RELATIONS: RelationsResponse = {
  items: [
    {
      id: "rel1",
      kind: "imports",
      origin: "extracted",
      confidence: 1,
      detail: "pkg.b",
      created_at: "",
      source: {
        file_id: "fa",
        fragment_id: null,
        rel_path: "pkg/a.py",
        name: null,
        symbol_path: null,
        start_line: null,
        end_line: null,
      },
      target: {
        file_id: "fb",
        fragment_id: null,
        rel_path: "pkg/b.py",
        name: null,
        symbol_path: null,
        start_line: null,
        end_line: null,
      },
    },
  ],
  total: 1,
  limit: 200,
  offset: 0,
  counts_by_kind: { imports: 1 },
  counts_by_origin: { extracted: 1 },
};

function job(state: JobInfo["state"], kind: string): JobInfo {
  return {
    id: "jobR",
    kind,
    state,
    progress_done: 0,
    progress_total: 0,
    message: null,
    error: null,
    warnings: [],
    created_at: "",
    started_at: null,
    finished_at: null,
  };
}

const CLUSTER_RUN: ClusteringRunDTO = {
  id: "cl1",
  embedding_run_id: "emb1",
  space: "original",
  projection_run_id: null,
  algorithm: "dbscan",
  metric: "cosine",
  params: { eps: 0.5, min_samples: 5 },
  count: 21,
  n_clusters: 3,
  noise: 2,
  stale: false,
  cache_ok: true,
  versions: {},
  created_at: "",
  updated_at: "",
};

const LABELS: ClusteringLabelsDTO = {
  clustering_id: "cl1",
  space: "original",
  algorithm: "dbscan",
  metric: "cosine",
  n_clusters: 3,
  noise: 1,
  count: 3,
  ids: ["fragA", "fragB", "fragC"],
  labels: [0, 2, -1],
};

beforeEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({ current: PROJECT });
  useAnalysisStore.getState().reset();
  useSpaceStore.getState().reset();
});

describe("analysisStore: neighbors & relations", () => {
  it("loads neighbors and remembers which fragment they belong to", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /api/projects/p1/neighbors": NEIGHBORS,
    });
    vi.stubGlobal("fetch", fetchMock);

    await useAnalysisStore.getState().loadNeighbors("fragA", 5, "cosine");
    const s = useAnalysisStore.getState();
    expect(s.neighbors?.neighbors[0].fragment_id).toBe("fragB");
    expect(s.neighborsFor).toBe("fragA");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ fragment_id: "fragA", k: 5, metric: "cosine" });
  });

  it("loads relations of one fragment (shared by the tab and the 3D lines)", async () => {
    const { fetchMock } = mockFetch({ "/api/projects/p1/relations": RELATIONS });
    vi.stubGlobal("fetch", fetchMock);
    await useAnalysisStore.getState().loadFragmentRelations("fragX");
    const s = useAnalysisStore.getState();
    expect(s.fragmentRelations?.items[0].kind).toBe("imports");
    expect(s.fragmentRelationsFor).toBe("fragX");
  });

  it("browser filters round-trip into query params and pagination", async () => {
    const { fetchMock, calls } = mockFetch({ "/api/projects/p1/relations": RELATIONS });
    vi.stubGlobal("fetch", fetchMock);
    await useAnalysisStore.getState().loadBrowser();
    useAnalysisStore.getState().setBrowserFilters({ kind: "imports", offset: 100 });
    await vi.waitFor(() => {
      const last = calls.filter((c) => c.url.includes("/relations")).pop();
      expect(last?.url).toContain("kind=imports");
      expect(last?.url).toContain("offset=100");
    });
  });

  it("extraction job: start → tick → done refreshes the browser", async () => {
    const running = mockFetch({
      "POST /api/projects/p1/relations/extract": mockResponse(202, job("queued", "relations")),
      "/api/projects/p1/jobs/jobR": job("running", "relations"),
      "/api/projects/p1/relations": RELATIONS,
    });
    vi.stubGlobal("fetch", running.fetchMock);

    await useAnalysisStore.getState().extractRelations();
    expect(useAnalysisStore.getState().activeJob?.state).toBe("queued");
    await useAnalysisStore.getState().tickActiveJob(); // queued → running
    expect(useAnalysisStore.getState().activeJob?.state).toBe("running");

    // backend finished: re-stub the job route and tick once more
    const done = mockFetch({
      "/api/projects/p1/jobs/jobR": job("done", "relations"),
      "/api/projects/p1/relations": RELATIONS,
    });
    vi.stubGlobal("fetch", done.fetchMock);
    await useAnalysisStore.getState().tickActiveJob(); // running → done
    expect(useAnalysisStore.getState().activeJob?.state).toBe("done");
    expect(useAnalysisStore.getState().browser?.total).toBe(1);
    expect(running.calls.some((c) => c.url.includes("/relations/extract"))).toBe(true);
  });

  it("import returns the honest per-row report", async () => {
    const report = { imported: 2, duplicates: 1, unresolved: [{ index: 3, kind: "calls", reason: "…" }] };
    const { fetchMock } = mockFetch({
      "POST /api/projects/p1/relations/import": report,
      "/api/projects/p1/relations": RELATIONS,
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await useAnalysisStore.getState().importRelations({ format: "ese-relations/v1" });
    expect(result?.imported).toBe(2);
    expect(useAnalysisStore.getState().lastImportReport?.unresolved).toHaveLength(1);
  });

  it("manual relation creation validates through the backend envelope", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/projects/p1/relations": mockResponse(404, {
        error: { code: "fragment_not_found", message: "Fragment 'x' does not exist." },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const ok = await useAnalysisStore.getState().createRelation({
      source_fragment_id: "x",
      target_fragment_id: "y",
      kind: "calls",
    });
    expect(ok).toBe(false);
    expect(useAnalysisStore.getState().error?.code).toBe("fragment_not_found");
  });
});

describe("analysisStore: clustering & groups", () => {
  it("startClustering posts the explicit space and metric", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /api/projects/p1/clustering/compute": mockResponse(202, job("queued", "clustering")),
    });
    vi.stubGlobal("fetch", fetchMock);
    await useAnalysisStore.getState().startClustering({
      embedding_run_id: "emb1",
      space: "projection",
      projection_run_id: "pr1",
      algorithm: "dbscan",
      metric: "euclidean",
      params: { eps: 0.4, min_samples: 3 },
    });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      space: "projection",
      projection_run_id: "pr1",
      metric: "euclidean",
      params: { eps: 0.4, min_samples: 3 },
    });
  });

  it("«На сцену» applies labels to the scene store (explicit, never silent)", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/clustering/cl1/labels": LABELS,
    });
    vi.stubGlobal("fetch", fetchMock);
    useAnalysisStore.setState({ clusteringRuns: [CLUSTER_RUN] });

    await useAnalysisStore.getState().showClusteringOnScene("cl1");
    const space = useSpaceStore.getState();
    expect(space.colorBy).toBe("cluster");
    expect(space.clusterLabels?.get("fragA")).toBe(0);
    expect(space.clusterLabels?.get("fragC")).toBe(-1);
    expect(space.clusterCaption).toContain("DBSCAN");
    expect(space.clusterCaption).toContain("шум: 1");

    useAnalysisStore.getState().clearClusteringColors();
    expect(useSpaceStore.getState().colorBy).toBe("kind");
    expect(useSpaceStore.getState().clusterLabels).toBeNull();
  });

  it("groups: create posts the selection, delete refreshes the list", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /api/projects/p1/groups": mockResponse(201, {
        id: "g1",
        name: "интересное",
        count: 2,
        fragment_ids: ["fragA", "fragB"],
        created_at: "",
      }),
      "/api/projects/p1/groups": [
        { id: "g1", name: "интересное", count: 2, fragment_ids: ["fragA", "fragB"], created_at: "" },
      ],
      "DELETE /api/projects/p1/groups/g1": { deleted: "g1" },
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await useAnalysisStore.getState().createGroup("интересное", ["fragA", "fragB"]);
    expect(ok).toBe(true);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ name: "интересное", fragment_ids: ["fragA", "fragB"] });

    await useAnalysisStore.getState().deleteGroup("g1");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("analysisStore: slice overlay", () => {
  const SLICE_BODY = {
    embedding_run_id: "emb1",
    normal_kind: "axis",
    normal_index: 2,
    dim: 8,
    position: 0,
    thickness: 0,
    total: 3,
    in_layer: 0,
    u_min: -4,
    u_max: 6,
    ids: ["fragA", "fragB", "fragC"],
    u: [-4, 1, 6],
    note: "Срез — математическая выборка…",
  };

  it("first compute derives position/thickness from the served range", async () => {
    const { fetchMock } = mockFetch({ "POST /api/projects/p1/slices/compute": SLICE_BODY });
    vi.stubGlobal("fetch", fetchMock);

    await useAnalysisStore.getState().computeSlice("emb1", "axis", 2);
    const overlay = useSpaceStore.getState().sliceOverlay;
    expect(overlay).not.toBeNull();
    expect(overlay?.position).toBe(1); // center of [-4, 6]
    expect(overlay?.thickness).toBeCloseTo(1); // 10% of the range
    expect(overlay?.uById.get("fragB")).toBe(1);
    expect(overlay?.total).toBe(3);
  });

  it("explicit position/thickness win over the defaults", async () => {
    const { fetchMock } = mockFetch({ "POST /api/projects/p1/slices/compute": SLICE_BODY });
    vi.stubGlobal("fetch", fetchMock);
    await useAnalysisStore.getState().computeSlice("emb1", "pca", 0, null, 2.5, 0.4);
    const overlay = useSpaceStore.getState().sliceOverlay;
    expect(overlay?.position).toBe(2.5);
    expect(overlay?.thickness).toBe(0.4);
  });

  it("patchSliceOverlay moves the window WITHOUT a round-trip", async () => {
    const { fetchMock, calls } = mockFetch({ "POST /api/projects/p1/slices/compute": SLICE_BODY });
    vi.stubGlobal("fetch", fetchMock);
    await useAnalysisStore.getState().computeSlice("emb1", "axis", 2);
    const before = calls.length;

    useSpaceStore.getState().patchSliceOverlay({ position: 3 });
    useSpaceStore.getState().patchSliceOverlay({ thickness: 2 });
    expect(calls.length).toBe(before); // sliders are pure client math
    expect(useSpaceStore.getState().sliceOverlay?.position).toBe(3);
    expect(useSpaceStore.getState().sliceOverlay?.thickness).toBe(2);
  });

  it("saved slices: save posts the spec, apply sends the RESOLVED vector", async () => {
    const saved: SavedSliceDTO = {
      id: "s1",
      name: "PC1 слой",
      embedding_run_id: "emb1",
      normal_kind: "pca",
      normal_index: 0,
      dim: 8,
      vector: [0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0],
      position: 0.25,
      thickness: 0.1,
      created_at: "",
    };
    const { fetchMock, calls } = mockFetch({
      "POST /api/projects/p1/slices/compute": SLICE_BODY,
      "POST /api/projects/p1/slices": mockResponse(201, saved),
      "/api/projects/p1/slices": [saved],
    });
    vi.stubGlobal("fetch", fetchMock);

    await useAnalysisStore.getState().computeSlice("emb1", "pca", 0, null, 0.25, 0.1);
    await useAnalysisStore.getState().saveSlice("PC1 слой");
    const savePost = calls.find((c) => c.method === "POST" && c.url.endsWith("/slices"));
    // the overlay carries the spec as RESOLVED/echoed by the backend response
    expect(savePost?.body).toMatchObject({
      name: "PC1 слой",
      normal: { kind: "axis", index: 2 },
      position: 0.25,
      thickness: 0.1,
    });

    useAnalysisStore.setState({ savedSlices: [saved] });
    await useAnalysisStore.getState().applySavedSlice("s1");
    const applyPost = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/slices/compute"),
    ).pop();
    expect((applyPost?.body as { normal: { kind: string; vector?: number[] } }).normal.kind).toBe(
      "vector",
    );
    const overlay = useSpaceStore.getState().sliceOverlay;
    expect(overlay?.position).toBe(0.25);
    // the human-readable intent is restored for the panel
    expect(overlay?.normalKind).toBe("pca");
    expect(overlay?.normalIndex).toBe(0);
  });
});
