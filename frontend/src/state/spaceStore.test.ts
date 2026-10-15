/**
 * spaceStore tests: cloud building from served DTOs (no fabricated data —
 * buildCloud only reshapes what the backend returned), active-projection
 * picking (fresh preferred, stale as a labeled fallback), fetch lifecycle
 * and error mapping.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectionPoints, ProjectionRunDTO } from "../api/types";
import { mockFetch, mockReject, mockResponse } from "../testUtils";
import { useProjectStore } from "./projectStore";
import { buildCloud, pickActiveProjections, useSpaceStore } from "./spaceStore";

const PROJECT = { id: "p1", name: "Sample" } as never;

function run(overrides: Partial<ProjectionRunDTO>): ProjectionRunDTO {
  return {
    id: "proj3d",
    embedding_run_id: "emb1",
    method: "pca",
    method_display_name: "PCA",
    n_components: 3,
    params: { whiten: false },
    seed: 42,
    axis_labels: ["PC1", "PC2", "PC3"],
    axis_info: [0.6, 0.3, 0.1],
    count: 2,
    stale: false,
    cache_ok: true,
    versions: { numpy: "2.4.6" },
    created_at: "2026-10-15T10:00:00+00:00",
    updated_at: "2026-10-15T10:00:00+00:00",
    ...overrides,
  };
}

function pointsDTO(overrides: Partial<ProjectionPoints> = {}): ProjectionPoints {
  return {
    projection_id: "proj3d",
    method: "pca",
    method_display_name: "PCA",
    n_components: 3,
    axis_labels: ["PC1", "PC2", "PC3"],
    axis_info: [0.6, 0.3, 0.1],
    stale: false,
    count: 2,
    dropped_orphans: 0,
    points: [
      {
        fragment_id: "fragA",
        file_id: "fa",
        rel_path: "src/a.py",
        kind: "method",
        name: "m",
        symbol_path: "Cls.m",
        start_line: 5,
        end_line: 9,
        coords: [-2, 0, 0.5],
      },
      {
        fragment_id: "fragB",
        file_id: "fb",
        rel_path: "src/b.py",
        kind: "class",
        name: "B",
        symbol_path: "B",
        start_line: 1,
        end_line: 30,
        coords: [2, 1, -0.5],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({ current: PROJECT });
  useSpaceStore.setState({
    cloud3d: null,
    cloud2d: null,
    loading3d: false,
    loading2d: false,
    error: null,
    hoveredId: null,
    hoverScreen: null,
    interactionMode: "orbit",
    pointSize: 3,
  });
});

describe("buildCloud", () => {
  it("reshapes the served DTO into render buffers without altering data", () => {
    const cloud = buildCloud(pointsDTO(), run({}));
    expect(cloud.metas).toHaveLength(2);
    expect(cloud.metas[0]).toEqual({
      fragmentId: "fragA",
      fileId: "fa",
      relPath: "src/a.py",
      kind: "method",
      name: "m",
      symbolPath: "Cls.m",
      startLine: 5,
      endLine: 9,
    });
    expect(Array.from(cloud.coords)).toEqual([-2, 0, 0.5, 2, 1, -0.5]);
    expect(cloud.indexById.get("fragB")).toBe(1);
    // display buffer is the view-normalized copy inside [-1, 1]
    for (const v of Array.from(cloud.display)) {
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
    }
    // raw coordinates are untouched (projections belong to the backend)
    expect(cloud.coords).not.toBe(cloud.display);
  });
});

describe("pickActiveProjections", () => {
  const p3fresh = run({ id: "p3", n_components: 3, updated_at: "2026-10-15T12:00:00+00:00" });
  const p3stale = run({
    id: "p3s",
    n_components: 3,
    stale: true,
    updated_at: "2026-10-15T13:00:00+00:00",
  });
  const p2fresh = run({ id: "p2", n_components: 2, updated_at: "2026-10-15T12:00:00+00:00" });
  const otherRun = run({ id: "x3", embedding_run_id: "embOTHER", n_components: 3 });
  const damaged = run({ id: "d3", n_components: 3, cache_ok: false });

  it("prefers the freshest non-stale projection per component count", () => {
    const picked = pickActiveProjections([p3stale, p3fresh, p2fresh], "emb1");
    expect(picked.three?.id).toBe("p3");
    expect(picked.two?.id).toBe("p2");
  });

  it("falls back to a stale projection (UI shows the badge) but never a damaged one", () => {
    const picked = pickActiveProjections([p3stale, damaged], "emb1");
    expect(picked.three?.id).toBe("p3s");
    const onlyDamaged = pickActiveProjections([damaged], "emb1");
    expect(onlyDamaged.three).toBeNull();
  });

  it("ignores projections of other embedding runs", () => {
    const picked = pickActiveProjections([otherRun], "emb1");
    expect(picked.three).toBeNull();
    expect(picked.two).toBeNull();
  });
});

describe("setActiveProjection", () => {
  it("loads inventory + points and builds the cloud", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/projections/proj3d/points": pointsDTO(),
      "/api/projects/p1/projections": [run({})],
    });
    vi.stubGlobal("fetch", fetchMock);

    await useSpaceStore.getState().setActiveProjection("3d", "proj3d");
    const { cloud3d, loading3d, error } = useSpaceStore.getState();
    expect(error).toBeNull();
    expect(loading3d).toBe(false);
    expect(cloud3d?.projection.id).toBe("proj3d");
    expect(cloud3d?.metas).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("/api/projects/p1/projections/proj3d/points"))).toBe(true);
  });

  it("skips re-fetching the projection already on screen", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/projections/proj3d/points": pointsDTO(),
      "/api/projects/p1/projections": [run({})],
    });
    vi.stubGlobal("fetch", fetchMock);

    await useSpaceStore.getState().setActiveProjection("3d", "proj3d");
    const first = calls.length;
    await useSpaceStore.getState().setActiveProjection("3d", "proj3d");
    expect(calls.length).toBe(first); // no new requests

    // …but force=true does refetch (used after a compute job finished).
    await useSpaceStore.getState().setActiveProjection("3d", "proj3d", { force: true });
    expect(calls.length).toBeGreaterThan(first);
  });

  it("null clears the view", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/projections/proj3d/points": pointsDTO(),
      "/api/projects/p1/projections": [run({})],
    });
    vi.stubGlobal("fetch", fetchMock);
    await useSpaceStore.getState().setActiveProjection("3d", "proj3d");
    expect(useSpaceStore.getState().cloud3d).not.toBeNull();
    await useSpaceStore.getState().setActiveProjection("3d", null);
    expect(useSpaceStore.getState().cloud3d).toBeNull();
  });

  it("maps backend errors (e.g. damaged cache → recompute hint)", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/projections/proj3d/points": mockResponse(409, {
        error: {
          code: "projection_cache_unavailable",
          message: "Coordinate cache is missing or damaged.",
          hint: "Recompute the projection",
        },
      }),
      "/api/projects/p1/projections": [run({})],
    });
    vi.stubGlobal("fetch", fetchMock);

    await useSpaceStore.getState().setActiveProjection("3d", "proj3d");
    const { cloud3d, loading3d, error } = useSpaceStore.getState();
    expect(cloud3d).toBeNull();
    expect(loading3d).toBe(false);
    expect(error?.code).toBe("projection_cache_unavailable");
    expect(error?.hint).toContain("Recompute");
  });

  it("survives a backend outage", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/projections": mockReject(new TypeError("Failed to fetch")),
    });
    vi.stubGlobal("fetch", fetchMock);
    await useSpaceStore.getState().setActiveProjection("3d", "proj3d");
    expect(useSpaceStore.getState().error?.code).toBe("backend_unreachable");
  });

  it("errors when the projection vanished from the inventory", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/projections/proj3d/points": pointsDTO(),
      "/api/projects/p1/projections": [], // not in inventory
    });
    vi.stubGlobal("fetch", fetchMock);
    await useSpaceStore.getState().setActiveProjection("3d", "proj3d");
    expect(useSpaceStore.getState().error?.code).toBe("projection_not_found");
  });
});

describe("view state", () => {
  it("hover state is shared across views but remembers its origin", () => {
    useSpaceStore.getState().setHover("fragA", { kind: "2d", x: 10, y: 20 });
    expect(useSpaceStore.getState().hoveredId).toBe("fragA");
    expect(useSpaceStore.getState().hoverScreen).toEqual({ kind: "2d", x: 10, y: 20 });
    useSpaceStore.getState().setHover(null);
    expect(useSpaceStore.getState().hoveredId).toBeNull();
    expect(useSpaceStore.getState().hoverScreen).toBeNull();
  });

  it("view mode defaults to 3D and switches", () => {
    expect(useSpaceStore.getState().viewMode).toBe("3d");
    useSpaceStore.getState().setViewMode("split");
    expect(useSpaceStore.getState().viewMode).toBe("split");
    useSpaceStore.getState().setViewMode("2d");
    expect(useSpaceStore.getState().viewMode).toBe("2d");
    // reset() drops DATA (clouds/hover) but keeps the user's view preference
    useSpaceStore.getState().reset();
    expect(useSpaceStore.getState().viewMode).toBe("2d");
    useSpaceStore.getState().setViewMode("3d");
  });

  it("point size clamps to the supported range", () => {
    useSpaceStore.getState().setPointSize(99);
    expect(useSpaceStore.getState().pointSize).toBe(8);
    useSpaceStore.getState().setPointSize(-4);
    expect(useSpaceStore.getState().pointSize).toBe(1);
  });

  it("reset clears clouds and hover", () => {
    useSpaceStore.setState({
      hoveredId: "fragA",
      hoverScreen: { kind: "3d", x: 1, y: 2 },
      loading3d: true,
      error: { code: "x", message: "m" },
    });
    useSpaceStore.getState().reset();
    const s = useSpaceStore.getState();
    expect(s.cloud3d).toBeNull();
    expect(s.cloud2d).toBeNull();
    expect(s.hoveredId).toBeNull();
    expect(s.loading3d).toBe(false);
    expect(s.error).toBeNull();
  });
});
