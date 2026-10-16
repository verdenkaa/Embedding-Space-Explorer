/**
 * savedExperimentsStore tests (stage 5): capture of the live SPACE state,
 * save payload, honest open-report (missing references are LISTED, never
 * substituted), selection restore and truncation at the cap.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExperimentDTO } from "../api/types";
import { mockFetch, mockResponse } from "../testUtils";
import { useAnalysisStore } from "./analysisStore";
import { useProjectStore } from "./projectStore";
import { SELECTION_CAP, useSavedExperimentsStore } from "./savedExperimentsStore";
import { useSpaceStore } from "./spaceStore";

const PROJECT = { id: "p1", name: "Sample" } as never;

function overlay(over: Record<string, unknown> = {}) {
  return {
    embeddingRunId: "emb1",
    normalKind: "pca",
    normalIndex: 1,
    position: 0.1,
    thickness: 0.5,
    uMin: -1,
    uMax: 1,
    total: 10,
    uById: new Map<string, number>(),
    note: "",
    vector: null,
    savedSliceId: null,
    ...over,
  } as never;
}

function expDto(over: Partial<ExperimentDTO> = {}): ExperimentDTO {
  return {
    id: "e1",
    name: "baseline",
    description: null,
    created_at: "2026-10-16T10:00:00+00:00",
    config: {
      view_mode: "3d",
      embedding_run_id: null,
      projections: { three: null, two: [], four: null },
      slice: null,
      slice_display: "off",
      clustering_run_id: null,
      color_by: "kind",
      group_ids: [],
      selection: [],
      selection_truncated: false,
      metric_run_ids: [],
    },
    snapshot: {},
    live_status: { missing: {}, stale: {} },
    ...over,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({ current: PROJECT, selectedFragmentIds: [] });
  useSpaceStore.getState().reset();
  useAnalysisStore.getState().reset();
  useSavedExperimentsStore.setState({
    experiments: null,
    loading: false,
    error: null,
    lastOpenReport: null,
  });
});

describe("captureSpaceState", () => {
  it("captures views, slice (by saved id when known), clustering, groups, selection", () => {
    useSpaceStore.setState({
      viewMode: "split",
      cloud3d: { projection: { id: "p3", embedding_run_id: "emb1" } } as never,
      clouds2d: [{ projection: { id: "p2", embedding_run_id: "emb1" } } as never],
      sliceOverlay: overlay({ savedSliceId: "sl1" }),
      sliceDisplay: "only",
      clusterRunId: "cl1",
      colorBy: "cluster",
    });
    useAnalysisStore.setState({
      groups: [{ id: "g1", name: "grp", count: 1, fragment_ids: ["f1"], created_at: "" }],
      metricRuns: [{ id: "m1" } as never],
    });
    useProjectStore.setState({ selectedFragmentIds: ["f1", "f2"] });

    const cfg = useSavedExperimentsStore.getState().captureSpaceState();
    expect(cfg.view_mode).toBe("split");
    expect(cfg.embedding_run_id).toBe("emb1");
    expect(cfg.projections).toEqual({ three: "p3", two: ["p2"], four: null });
    expect(cfg.slice).toEqual({ saved_slice_id: "sl1", position: 0.1, thickness: 0.5 });
    expect(cfg.slice_display).toBe("only");
    expect(cfg.clustering_run_id).toBe("cl1");
    expect(cfg.color_by).toBe("cluster");
    expect(cfg.group_ids).toEqual(["g1"]);
    expect(cfg.selection).toEqual(["f1", "f2"]);
    expect(cfg.selection_truncated).toBe(false);
    expect(cfg.metric_run_ids).toEqual(["m1"]);
  });

  it("captures an ad-hoc slice by its definition (kind/index/vector)", () => {
    useSpaceStore.setState({
      sliceOverlay: overlay({ normalKind: "vector", vector: [1, 0, 0], normalIndex: null }),
    });
    const cfg = useSavedExperimentsStore.getState().captureSpaceState();
    expect(cfg.slice).toMatchObject({
      embedding_run_id: "emb1",
      normal_kind: "vector",
      normal_vector: [1, 0, 0],
    });
    expect(cfg.slice?.saved_slice_id ?? null).toBeNull();
  });

  it("never claims cluster coloring without a clustering run", () => {
    useSpaceStore.setState({ colorBy: "cluster", clusterRunId: null });
    const cfg = useSavedExperimentsStore.getState().captureSpaceState();
    expect(cfg.color_by).toBe("kind");
    expect(cfg.clustering_run_id).toBeNull();
  });

  it("truncates the selection at the cap and flags it", () => {
    const ids = Array.from({ length: SELECTION_CAP + 1 }, (_, i) => `f${i}`);
    useProjectStore.setState({ selectedFragmentIds: ids });
    const cfg = useSavedExperimentsStore.getState().captureSpaceState();
    expect(cfg.selection).toHaveLength(SELECTION_CAP);
    expect(cfg.selection_truncated).toBe(true);
  });
});

describe("saveExperiment", () => {
  it("posts the captured config under the trimmed name and reloads the list", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /api/projects/p1/experiments": mockResponse(201, expDto()),
      "/api/projects/p1/experiments": [
        { id: "e1", name: "baseline", description: null, created_at: "", summary: {} },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    useSpaceStore.setState({ viewMode: "4d" });

    const ok = await useSavedExperimentsStore.getState().saveExperiment("  baseline  ", " desc ");
    expect(ok).toBe(true);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      name: "baseline",
      description: "desc",
      config: { view_mode: "4d" },
    });
    expect(useSavedExperimentsStore.getState().experiments).toHaveLength(1);
  });

  it("refuses an empty name and surfaces backend errors (409 name taken)", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/projects/p1/experiments": mockResponse(409, {
        error: { code: "experiment_name_taken", message: "уже существует" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await useSavedExperimentsStore.getState().saveExperiment("   ", "")).toBe(false);
    expect(await useSavedExperimentsStore.getState().saveExperiment("dup", "")).toBe(false);
    const err = useSavedExperimentsStore.getState().error;
    expect(err?.code).toBe("experiment_name_taken");
  });
});

describe("openExperiment", () => {
  it("restores selection/view/slice-off and REPORTS missing references honestly", async () => {
    const dto = expDto({
      config: {
        ...expDto().config,
        view_mode: "split",
        projections: { three: "dead3", two: ["dead2a"], four: null },
        selection: ["f1", "f2"],
        clustering_run_id: "deadcl",
        color_by: "cluster",
      },
      live_status: {
        missing: {
          "projections.three": ["dead3"],
          "projections.two": ["dead2a"],
          clustering_run_id: ["deadcl"],
        },
        stale: {},
      },
    });
    const { fetchMock } = mockFetch({ "/api/projects/p1/experiments/e1": dto });
    vi.stubGlobal("fetch", fetchMock);
    useSpaceStore.setState({ sliceOverlay: overlay(), colorBy: "cluster", clusterRunId: "cl9" });

    const report = await useSavedExperimentsStore.getState().openExperiment("e1");
    expect(report).not.toBeNull();
    expect(report?.skipped).toEqual(
      expect.arrayContaining([
        "3D-проекция dead3 удалена",
        "2D-проекции (1) удалены",
        "кластеризация удалена",
      ]),
    );
    expect(report?.applied).toContain("выделение (2)");

    const space = useSpaceStore.getState();
    expect(space.viewMode).toBe("split");
    expect(useProjectStore.getState().selectedFragmentIds).toEqual(["f1", "f2"]);
    // missing clustering → colors are CLEARED, never left from another run
    expect(space.clusterLabels).toBeNull();
    expect(space.colorBy).toBe("kind");
    // slice null in the config → the live overlay is removed, display applied
    expect(space.sliceOverlay).toBeNull();
    expect(space.sliceDisplay).toBe("off");
    // the report is kept for the UI until dismissed
    expect(useSavedExperimentsStore.getState().lastOpenReport).toEqual(report);
    useSavedExperimentsStore.getState().clearOpenReport();
    expect(useSavedExperimentsStore.getState().lastOpenReport).toBeNull();
  });

  it("returns null and sets an error when the experiment vanished", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/experiments/gone": mockResponse(404, {
        error: { code: "experiment_not_found", message: "нет такого" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const report = await useSavedExperimentsStore.getState().openExperiment("gone");
    expect(report).toBeNull();
    expect(useSavedExperimentsStore.getState().error?.code).toBe("experiment_not_found");
  });
});
