/**
 * SpaceSection orchestration tests: the section mounts the full IDE layout
 * (corpus | 3D / controls / 2D | inspector) and auto-selects the freshest
 * cached projections per view for the active embedding run, loading REAL
 * coordinates through the API (mocked at the fetch level — the store and
 * client code under test are the production ones).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingRunDTO, ProjectionPoints, ProjectionRunDTO } from "../../api/types";
import { mockFetch } from "../../testUtils";
import { useProjectStore } from "../../state/projectStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useSpaceStore } from "../../state/spaceStore";

vi.mock("allotment", () => {
  const Allotment = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="allotment">{children}</div>
  );
  Allotment.Pane = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Allotment, default: Allotment };
});
vi.mock("./Scene3D", () => ({ Scene3D: () => <div data-testid="scene3d" /> }));
vi.mock("./Projection2D", () => ({ Projection2D: () => <div data-testid="projection2d" /> }));
vi.mock("./ProjectionControls", () => ({
  ProjectionControls: () => <div data-testid="projection-controls" />,
  ExperimentJobPoller: () => null,
}));
vi.mock("../corpus/CorpusPanel", () => ({ CorpusPanel: () => <div data-testid="corpus" /> }));
vi.mock("../inspector/SourceInspector", () => ({
  SourceInspector: () => <div data-testid="inspector" />,
}));
vi.mock("../corpus/JobProgress", () => ({ JobPoller: () => null }));

import { SpaceSection } from "./SpaceSection";

const EMB_RUN: EmbeddingRunDTO = {
  id: "emb1",
  model_id: "m",
  model_display_name: "MiniLM",
  dim: 384,
  mode: "raw_fragment",
  template_preview: "",
  params: {},
  count: 2,
  coverage: { fragments_total: 2, embedded: 2, stale: 0, missing: 0 },
  created_at: "",
  updated_at: "2026-10-15T12:00:00+00:00",
};

function proj(id: string, nc: number, stale: boolean, at: string): ProjectionRunDTO {
  return {
    id,
    embedding_run_id: "emb1",
    method: "pca",
    method_display_name: "PCA",
    n_components: nc,
    params: {},
    seed: 42,
    axis_labels: nc === 3 ? ["PC1", "PC2", "PC3"] : ["PC1", "PC2"],
    axis_info: null,
    count: 2,
    stale,
    cache_ok: true,
    versions: {},
    created_at: at,
    updated_at: at,
  };
}

function pointsFor(id: string, nc: number): ProjectionPoints {
  return {
    projection_id: id,
    method: "pca",
    method_display_name: "PCA",
    n_components: nc,
    axis_labels: nc === 3 ? ["PC1", "PC2", "PC3"] : ["PC1", "PC2"],
    axis_info: null,
    stale: false,
    count: 2,
    dropped_orphans: 0,
    points: [
      {
        fragment_id: "fragA",
        file_id: "fa",
        rel_path: "a.py",
        kind: "method",
        name: "m",
        symbol_path: "C.m",
        start_line: 1,
        end_line: 2,
        coords: nc === 3 ? [0.1, 0.2, 0.3] : [0.1, 0.2],
      },
      {
        fragment_id: "fragB",
        file_id: "fb",
        rel_path: "b.py",
        kind: "class",
        name: "B",
        symbol_path: "B",
        start_line: 3,
        end_line: 8,
        coords: nc === 3 ? [-0.2, 0.1, 0.0] : [-0.2, 0.1],
      },
    ],
  };
}

const INVENTORY = [
  proj("p3old", 3, true, "2026-10-15T11:00:00+00:00"),
  proj("p3fresh", 3, false, "2026-10-15T12:30:00+00:00"),
  proj("p2fresh", 2, false, "2026-10-15T12:30:00+00:00"),
];

function stubBackend() {
  const { fetchMock } = mockFetch({
    "/api/projects/p1/projections/p3fresh/points": pointsFor("p3fresh", 3),
    "/api/projects/p1/projections/p3old/points": pointsFor("p3old", 3),
    "/api/projects/p1/projections/p2fresh/points": pointsFor("p2fresh", 2),
    "/api/projects/p1/projections": INVENTORY,
    "/api/projects/p1/embeddings": [EMB_RUN],
    "/api/projections/methods": [],
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubBackend();
  useProjectStore.setState({ current: { id: "p1", name: "Sample" } as never, error: null });
  useExperimentStore.setState({
    runs: null,
    projections: null,
    projectionMethods: null,
    projRunId: null,
    activeJob: null,
    error: null,
  });
  useSpaceStore.getState().reset();
});

afterEach(cleanup);

describe("SpaceSection", () => {
  it("mounts the full layout: corpus | 3D / controls / 2D | inspector", async () => {
    render(<SpaceSection />);
    expect(screen.getByTestId("corpus")).toBeTruthy();
    expect(screen.getByTestId("scene3d")).toBeTruthy();
    expect(screen.getByTestId("projection-controls")).toBeTruthy();
    expect(screen.getByTestId("projection2d")).toBeTruthy();
    expect(screen.getByTestId("inspector")).toBeTruthy();
  });

  it("auto-selects the freshest projections per view and loads real points", async () => {
    render(<SpaceSection />);
    await waitFor(() => {
      const s = useSpaceStore.getState();
      expect(s.cloud3d?.projection.id).toBe("p3fresh");
      expect(s.cloud2d?.projection.id).toBe("p2fresh");
    });
    // coordinates are the served ones (never fabricated; stored as float32)
    const cloud3d = useSpaceStore.getState().cloud3d;
    expect(cloud3d?.metas.map((m) => m.fragmentId)).toEqual(["fragA", "fragB"]);
    const expected = new Float32Array([0.1, 0.2, 0.3]);
    expect(Array.from(cloud3d!.coords.slice(0, 3))).toEqual(Array.from(expected));
  });

  it("prefers a stale projection over showing nothing (badge tells the truth)", async () => {
    // inventory without fresh 3D
    const { fetchMock } = mockFetch({
      "/api/projects/p1/projections/p3old/points": pointsFor("p3old", 3),
      "/api/projects/p1/projections": [INVENTORY[0]],
      "/api/projects/p1/embeddings": [EMB_RUN],
      "/api/projections/methods": [],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SpaceSection />);
    await waitFor(() => {
      expect(useSpaceStore.getState().cloud3d?.projection.id).toBe("p3old");
    });
    expect(useSpaceStore.getState().cloud3d?.projection.stale).toBe(true);
    expect(useSpaceStore.getState().cloud2d).toBeNull();
  });
});
