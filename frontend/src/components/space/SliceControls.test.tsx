/**
 * SliceControls tests: the panel turns the mathematical slice on/off, moves
 * the window with LOCAL math only (no round-trips per slider tick), switches
 * the display mode and warns when the slice's embedding run does not match
 * the clouds on screen (honesty over silent no-ops).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingRunDTO } from "../../api/types";
import { mockFetch, type RecordedCall } from "../../testUtils";
import { useAnalysisStore } from "../../state/analysisStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { buildCloud, useSpaceStore } from "../../state/spaceStore";
import { SliceControls } from "./SliceControls";
import type { ProjectionPoints, ProjectionRunDTO } from "../../api/types";

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

const RUN_3D: ProjectionRunDTO = {
  id: "p3",
  embedding_run_id: "emb1",
  method: "pca",
  method_display_name: "PCA",
  n_components: 3,
  params: {},
  seed: 42,
  axis_labels: ["PC1", "PC2", "PC3"],
  axis_info: null,
  count: 2,
  stale: false,
  cache_ok: true,
  versions: {},
  created_at: "",
  updated_at: "",
};

const POINTS: ProjectionPoints = {
  projection_id: "p3",
  method: "pca",
  method_display_name: "PCA",
  n_components: 3,
  axis_labels: ["PC1", "PC2", "PC3"],
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
      coords: [0, 0, 0],
    },
    {
      fragment_id: "fragB",
      file_id: "fb",
      rel_path: "b.py",
      kind: "class",
      name: "B",
      symbol_path: "B",
      start_line: 3,
      end_line: 4,
      coords: [1, 1, 1],
    },
  ],
};

const SLICE_BODY = {
  embedding_run_id: "emb1",
  normal_kind: "axis",
  normal_index: 0,
  dim: 384,
  position: 0,
  thickness: 0,
  total: 2,
  in_layer: 0,
  u_min: -2,
  u_max: 2,
  ids: ["fragA", "fragB"],
  u: [-2, 2],
  note: "Срез — математическая выборка слоя в ИСХОДНОМ D-мерном пространстве.",
};

let fetchCalls: RecordedCall[] = [];

beforeEach(() => {
  vi.unstubAllGlobals();
  const { fetchMock, calls } = mockFetch({
    "POST /api/projects/p1/slices/compute": SLICE_BODY,
    "/api/projects/p1/slices": [],
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchCalls = calls;
  useProjectStore.setState({ current: { id: "p1", name: "Sample" } as never });
  useExperimentStore.setState({ runs: [EMB_RUN], projections: [RUN_3D] });
  useAnalysisStore.getState().reset();
  useSpaceStore.getState().reset();
});

afterEach(cleanup);

describe("SliceControls", () => {
  it("enabling fetches u(x) ONCE and derives the default window", async () => {
    useSpaceStore.setState({ cloud3d: buildCloud(POINTS, RUN_3D) });
    render(<SliceControls />);

    fireEvent.click(screen.getByRole("button", { name: /Срез/ }));
    await waitFor(() => {
      expect(useSpaceStore.getState().sliceOverlay).not.toBeNull();
    });
    const overlay = useSpaceStore.getState().sliceOverlay;
    expect(overlay?.position).toBe(0); // center of [-2, 2]
    expect(overlay?.thickness).toBeCloseTo(0.4); // 10% of the range
    // window [-0.2, 0.2] over u = {-2, 2} → nobody is inside (honest zero)
    expect(screen.getByText(/в слое 0 из 2/)).toBeTruthy();
  });

  it("sliders move the window with LOCAL math (no extra requests)", async () => {
    render(<SliceControls />);
    fireEvent.click(screen.getByRole("button", { name: /Срез/ }));
    await waitFor(() => expect(useSpaceStore.getState().sliceOverlay).not.toBeNull());
    const before = fetchCalls.filter((c) => c.url.includes("/slices/compute")).length;

    fireEvent.change(screen.getByLabelText("Позиция слоя вдоль нормали"), {
      target: { value: "-2" },
    });
    fireEvent.change(screen.getByLabelText("Толщина слоя"), { target: { value: "1" } });
    const overlay = useSpaceStore.getState().sliceOverlay;
    expect(overlay?.position).toBe(-2);
    expect(overlay?.thickness).toBe(1);
    // window [-2.5, -1.5] → fragA (u=-2) in layer
    expect(screen.getByText(/в слое 1 из 2/)).toBeTruthy();
    expect(fetchCalls.filter((c) => c.url.includes("/slices/compute")).length).toBe(before);
  });

  it("display modes switch between dim / only / off", async () => {
    render(<SliceControls />);
    fireEvent.click(screen.getByRole("button", { name: /Срез/ }));
    await waitFor(() => expect(useSpaceStore.getState().sliceOverlay).not.toBeNull());
    expect(useSpaceStore.getState().sliceDisplay).toBe("dim");

    fireEvent.click(screen.getByRole("radio", { name: "только слой" }));
    expect(useSpaceStore.getState().sliceDisplay).toBe("only");
    fireEvent.click(screen.getByRole("radio", { name: "все точки" }));
    expect(useSpaceStore.getState().sliceDisplay).toBe("off");
  });

  it("warns when the shown clouds belong to ANOTHER embedding run", async () => {
    const otherCloud = buildCloud(POINTS, { ...RUN_3D, embedding_run_id: "embOTHER" });
    useSpaceStore.setState({ cloud3d: otherCloud });
    render(<SliceControls />);
    fireEvent.click(screen.getByRole("button", { name: /Срез/ }));
    await waitFor(() => expect(useSpaceStore.getState().sliceOverlay).not.toBeNull());
    expect(screen.getByText(/не применяется/)).toBeTruthy();
  });

  it("disabling clears the overlay", async () => {
    render(<SliceControls />);
    const toggle = screen.getByRole("button", { name: /Срез/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(useSpaceStore.getState().sliceOverlay).not.toBeNull());
    fireEvent.click(toggle);
    expect(useSpaceStore.getState().sliceOverlay).toBeNull();
  });

  it("the honesty note travels with the overlay", async () => {
    render(<SliceControls />);
    fireEvent.click(screen.getByRole("button", { name: /Срез/ }));
    await waitFor(() => {
      expect(screen.getByText(/ИСХОДНОМ D-мерном пространстве/)).toBeTruthy();
    });
  });
});
