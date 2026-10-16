/**
 * Stage-4 analysis tabs tests: NEIGHBORS (navigation + honest note),
 * RELATIONS (provenance badges, file-level endpoints, navigation),
 * CLUSTERS (explicit space form → payload, «На сцену» applies labels,
 * manual groups from the shared selection).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingRunDTO, NeighborsResponse, RelationsResponse } from "../../api/types";
import { mockFetch, mockResponse, type RecordedCall } from "../../testUtils";
import { useAnalysisStore } from "../../state/analysisStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";
import { ClustersTab } from "./ClustersTab";
import { NeighborsTab } from "./NeighborsTab";
import { RelationsTab } from "./RelationsTab";

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
  updated_at: "",
};

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
      name: "Beta",
      symbol_path: "Beta",
      start_line: 3,
      end_line: 8,
      distance: 0.2,
      score: 0.8,
    },
  ],
  note: "Соседи посчитаны по ИСХОДНЫМ эмбеддингам (метрика cosine).",
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
        fragment_id: "fragA",
        rel_path: "pkg/a.py",
        name: "main",
        symbol_path: "main",
        start_line: 5,
        end_line: 6,
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
    {
      id: "rel2",
      kind: "calls",
      origin: "imported",
      confidence: 0.75,
      detail: null,
      created_at: "",
      source: {
        file_id: "fc",
        fragment_id: "fragC",
        rel_path: "pkg/c.py",
        name: "gamma",
        symbol_path: "gamma",
        start_line: 1,
        end_line: 2,
      },
      target: {
        file_id: "fa",
        fragment_id: "fragA",
        rel_path: "pkg/a.py",
        name: "main",
        symbol_path: "main",
        start_line: 5,
        end_line: 6,
      },
    },
  ],
  total: 2,
  limit: 200,
  offset: 0,
  counts_by_kind: { imports: 1, calls: 1 },
  counts_by_origin: { extracted: 1, imported: 1 },
};

let fetchCalls: RecordedCall[] = [];

beforeEach(() => {
  vi.unstubAllGlobals();
  const { fetchMock, calls } = mockFetch({
    "/api/projects/p1/files/fb": mockResponse(200, {
      file: { id: "fb", rel_path: "src/b.py" },
      fragments: [],
    }),
    "POST /api/projects/p1/clustering/compute": mockResponse(202, {
      id: "jobC",
      kind: "clustering",
      state: "queued",
      progress_done: 0,
      progress_total: 0,
      message: null,
      error: null,
      warnings: [],
      created_at: "",
      started_at: null,
      finished_at: null,
    }),
    "/api/projects/p1/clustering/cl1/labels": {
      clustering_id: "cl1",
      space: "original",
      algorithm: "dbscan",
      metric: "cosine",
      n_clusters: 2,
      noise: 1,
      count: 2,
      ids: ["fragA", "fragB"],
      labels: [0, -1],
    },
    "POST /api/projects/p1/groups": mockResponse(201, {
      id: "g1",
      name: "grp",
      count: 1,
      fragment_ids: ["fragA"],
      created_at: "",
    }),
    "/api/projects/p1/groups": [],
    "/api/projects/p1/clustering": [],
    "/api/projects/p1/embeddings": [EMB_RUN],
    "/api/projects/p1/projections": [],
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchCalls = calls;
  useProjectStore.setState({
    current: { id: "p1", name: "Sample" } as never,
    activeFragmentId: "fragA",
    selectedFragmentIds: ["fragA"],
    selectedFileId: "fa",
    fileDetail: null,
    error: null,
  });
  useAnalysisStore.getState().reset();
  useExperimentStore.setState({ runs: [EMB_RUN], projections: [] });
  useSpaceStore.getState().reset();
});

afterEach(cleanup);

describe("NeighborsTab", () => {
  it("shows ranked neighbors with the honest note and navigates on click", async () => {
    useAnalysisStore.setState({ neighbors: NEIGHBORS, neighborsFor: "fragA" });
    render(<NeighborsTab />);

    expect(screen.getByText(/ИСХОДНЫМ эмбеддингам/)).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.getByText("80.0%")).toBeTruthy(); // cosine score as percent

    fireEvent.click(screen.getByText("Beta"));
    await waitFor(() => {
      expect(useProjectStore.getState().activeFragmentId).toBe("fragB");
    });
  });

  it("without an active fragment it explains the next step (no fake list)", () => {
    useProjectStore.setState({ activeFragmentId: null });
    render(<NeighborsTab />);
    expect(screen.getByText(/Выберите точку/)).toBeTruthy();
  });
});

describe("RelationsTab", () => {
  it("separates outgoing/incoming and shows provenance badges", () => {
    useAnalysisStore.setState({
      fragmentRelations: RELATIONS,
      fragmentRelationsFor: "fragA",
    });
    render(<RelationsTab />);

    expect(screen.getByText(/Исходящие · 1/)).toBeTruthy();
    expect(screen.getByText(/Входящие · 1/)).toBeTruthy();
    expect(screen.getByText("imp")).toBeTruthy(); // imports text badge
    expect(screen.getByText("call")).toBeTruthy();
    expect(screen.getByText("извлечено")).toBeTruthy();
    expect(screen.getByText("импорт")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy(); // imported confidence
    // extracted relations show the EVIDENCE, not a pseudo-similarity score
    expect(screen.getByText("pkg.b")).toBeTruthy(); // module specifier detail
    expect(screen.queryByText("100%")).toBeNull(); // confidence 1.0 is a fact, not a %
    // the note keeps structural ≠ semantic
    expect(screen.getByText(/НЕ семантическая близость/)).toBeTruthy();
    expect(screen.getByText(/NEIGHBORS/)).toBeTruthy();
  });

  it("file-level endpoint navigates to the file (honest, no fake fragment)", async () => {
    useAnalysisStore.setState({
      fragmentRelations: RELATIONS,
      fragmentRelationsFor: "fragA",
    });
    render(<RelationsTab />);
    fireEvent.click(screen.getByText("pkg/b.py"));
    await waitFor(() => {
      expect(useProjectStore.getState().selectedFileId).toBe("fb");
    });
  });

  it("empty state offers extraction/import instead of silence", () => {
    useAnalysisStore.setState({
      fragmentRelations: { ...RELATIONS, items: [], total: 0 },
      fragmentRelationsFor: "fragA",
    });
    render(<RelationsTab />);
    expect(screen.getByText(/пока нет связей/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Извлечь связи" })).toBeTruthy();
  });
});

describe("ClustersTab", () => {
  it("starts DBSCAN with the explicit space and parameters", async () => {
    render(<ClustersTab />);

    fireEvent.change(screen.getByLabelText("eps (радиус окрестности)"), {
      target: { value: "0.35" },
    });
    fireEvent.change(screen.getByLabelText("min_samples"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Запустить DBSCAN" }));

    await waitFor(() => {
      expect(useAnalysisStore.getState().activeJob?.id).toBe("jobC");
    });
    const post = fetchCalls.find((c) => c.url.includes("/clustering/compute"));
    expect(post?.body).toMatchObject({
      space: "original",
      metric: "cosine",
      params: { eps: 0.35, min_samples: 3 },
    });
  });

  it("«На сцену» applies labels to the scenes (colorBy switches to cluster)", async () => {
    useAnalysisStore.setState({
      clusteringRuns: [
        {
          id: "cl1",
          embedding_run_id: "emb1",
          space: "original",
          projection_run_id: null,
          algorithm: "dbscan",
          metric: "cosine",
          params: { eps: 0.5, min_samples: 5 },
          count: 2,
          n_clusters: 1,
          noise: 1,
          stale: false,
          cache_ok: true,
          versions: {},
          created_at: "",
          updated_at: "",
        },
      ],
    });
    render(<ClustersTab />);
    fireEvent.click(screen.getByRole("button", { name: "На сцену" }));
    await waitFor(() => {
      expect(useSpaceStore.getState().colorBy).toBe("cluster");
    });
    expect(useSpaceStore.getState().clusterLabels?.get("fragB")).toBe(-1);
  });

  it("saves the current selection as a manual group", async () => {
    render(<ClustersTab />);
    fireEvent.change(screen.getByLabelText("Имя группы"), { target: { value: "grp" } });
    fireEvent.click(screen.getByRole("button", { name: /Сохранить выделение \(1\)/ }));
    await waitFor(() => {
      const post = fetchCalls.find((c) => c.url.endsWith("/groups") && c.method === "POST");
      expect(post?.body).toEqual({ name: "grp", fragment_ids: ["fragA"] });
    });
  });
});
