/**
 * Scene4D tests. The R3F Canvas is mocked (no WebGL in jsdom — same
 * strategy as Scene3D.test): we verify the honest states, the badge, and
 * the "time" slider panel (window over the 4th axis, count in layer,
 * full-range reset, play/pause animation). The layer math itself is
 * unit-tested in selectionMath.test.ts.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectionPoints, ProjectionRunDTO } from "../../api/types";

vi.mock("@react-three/fiber", () => ({
  Canvas: () => null,
  useThree: () => ({}),
}));
vi.mock("@react-three/drei", () => ({
  Billboard: () => null,
  OrbitControls: () => null,
}));

import { useProjectStore } from "../../state/projectStore";
import { DEFAULT_SLICE_4D, buildCloud, useSpaceStore } from "../../state/spaceStore";
import { Scene4D } from "./Scene4D";

const RUN: ProjectionRunDTO = {
  id: "proj4d",
  embedding_run_id: "emb1",
  method: "pca",
  method_display_name: "PCA",
  n_components: 4,
  params: { whiten: false },
  seed: 42,
  axis_labels: ["PC1", "PC2", "PC3", "PC4"],
  axis_info: [0.5, 0.25, 0.15, 0.1],
  count: 3,
  stale: false,
  cache_ok: true,
  versions: {},
  created_at: "",
  updated_at: "2026-10-15T12:00:00+00:00",
};

// axis-3 ("time") values: 0, 5, 10 → range 10
const POINTS: ProjectionPoints = {
  projection_id: "proj4d",
  method: "pca",
  method_display_name: "PCA",
  n_components: 4,
  axis_labels: ["PC1", "PC2", "PC3", "PC4"],
  axis_info: [0.5, 0.25, 0.15, 0.1],
  stale: false,
  count: 3,
  dropped_orphans: 0,
  points: [
    {
      fragment_id: "fragA",
      file_id: "fa",
      rel_path: "src/a.py",
      kind: "method",
      name: "early",
      symbol_path: "A",
      start_line: 1,
      end_line: 2,
      coords: [0.1, 0.2, 0.3, 0],
    },
    {
      fragment_id: "fragB",
      file_id: "fb",
      rel_path: "src/b.py",
      kind: "class",
      name: "middle",
      symbol_path: "B",
      start_line: 3,
      end_line: 4,
      coords: [-0.2, 0.1, 0.0, 5],
    },
    {
      fragment_id: "fragC",
      file_id: "fc",
      rel_path: "src/c.py",
      kind: "function",
      name: "late",
      symbol_path: "c",
      start_line: 5,
      end_line: 6,
      coords: [0.4, -0.3, 0.2, 10],
    },
  ],
};

function seedCloud(stale = false) {
  useSpaceStore.setState({
    cloud4d: buildCloud(POINTS, { ...RUN, stale }),
    loading4d: false,
    error: null,
    hoveredId: null,
    hoverScreen: null,
    slice4d: { ...DEFAULT_SLICE_4D },
  });
}

beforeEach(() => {
  useProjectStore.setState({
    current: { id: "p1", name: "Sample" } as never,
    activeFragmentId: null,
    selectedFragmentIds: [],
    locatedFragments: null,
    locatedNote: null,
    error: null,
  });
  useSpaceStore.setState({
    cloud3d: null,
    clouds2d: [],
    cloud4d: null,
    loading3d: false,
    loading2d: false,
    loading4d: false,
    error: null,
    hoveredId: null,
    hoverScreen: null,
    slice4d: { ...DEFAULT_SLICE_4D },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Scene4D states", () => {
  it("empty state explains how to build a 4-component projection", () => {
    render(<Scene4D />);
    expect(screen.getByText(/4D-вид пуст/)).toBeTruthy();
    expect(screen.getByText(/Построить 4D/)).toBeTruthy();
    expect(screen.getByText(/Сырые оси/)).toBeTruthy();
  });

  it("loading state", () => {
    useSpaceStore.setState({ loading4d: true });
    render(<Scene4D />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("error state shows message and hint", () => {
    useSpaceStore.setState({
      error: { code: "x", message: "Кэш повреждён.", hint: "Пересчитайте" },
    });
    render(<Scene4D />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Кэш повреждён.")).toBeTruthy();
  });
});

describe("Scene4D time slider", () => {
  it("badge names the method, all four axes and the layer count honestly", () => {
    seedCloud();
    render(<Scene4D />);
    // default slice: t=0.5 → 5, window 0.15 → ±0.75 → only fragB in layer
    expect(screen.getByText(/PCA · 4D · PC1 \/ PC2 \/ PC3 \/ PC4/)).toBeTruthy();
    expect(screen.getByText("свежая")).toBeTruthy();
    expect(screen.getAllByText(/в слое 1 из 3/).length).toBeGreaterThan(0);
  });

  it("stale projection is labeled", () => {
    seedCloud(true);
    render(<Scene4D />);
    expect(screen.getByText("устарела")).toBeTruthy();
  });

  it("position and thickness sliders drive the slice state", () => {
    seedCloud();
    render(<Scene4D />);
    const pos = screen.getByLabelText("Позиция окна по четвёртой оси");
    const width = screen.getByLabelText("Толщина окна по четвёртой оси");

    fireEvent.change(pos, { target: { value: "0" } });
    expect(useSpaceStore.getState().slice4d.tFrac).toBe(0);
    // t = 0 (raw 0), default window ±0.75 → only fragA
    expect(screen.getAllByText(/в слое 1 из 3/).length).toBeGreaterThan(0);

    fireEvent.change(width, { target: { value: "1" } });
    expect(useSpaceStore.getState().slice4d.wFrac).toBe(1);
  });

  it("«весь диапазон» shows every point again", () => {
    seedCloud();
    render(<Scene4D />);
    fireEvent.click(screen.getByRole("button", { name: "весь диапазон" }));
    const s = useSpaceStore.getState().slice4d;
    expect(s.tFrac).toBe(0.5);
    expect(s.wFrac).toBe(1);
    expect(screen.getAllByText(/в слое 3 из 3/).length).toBeGreaterThan(0);
  });

  it("an empty window explains what to do instead of showing a dead scene", () => {
    seedCloud();
    render(<Scene4D />);
    // t = 0.5 → 5, минимальное окно 0.005 → ±0.025 → only fragB… take t=0.75
    fireEvent.change(screen.getByLabelText("Позиция окна по четвёртой оси"), {
      target: { value: "0.75" },
    });
    fireEvent.change(screen.getByLabelText("Толщина окна по четвёртой оси"), {
      target: { value: "0.005" },
    });
    expect(screen.getAllByText(/в слое 0 из 3/).length).toBeGreaterThan(0);
    expect(screen.getByText(/в окне нет точек/)).toBeTruthy();
  });

  it("▶ animates the window (ping-pong), ⏸ stops it", () => {
    vi.useFakeTimers();
    seedCloud();
    render(<Scene4D />);
    const playBtn = screen.getByRole("button", { name: "\u25b6" });
    expect(useSpaceStore.getState().slice4d.playing).toBe(false);

    fireEvent.click(playBtn);
    expect(useSpaceStore.getState().slice4d.playing).toBe(true);

    const t0 = useSpaceStore.getState().slice4d.tFrac;
    act(() => {
      vi.advanceTimersByTime(200); // 5 ticks × 0.006
    });
    expect(useSpaceStore.getState().slice4d.tFrac).toBeGreaterThan(t0);

    fireEvent.click(screen.getByRole("button", { name: "\u23f8" }));
    expect(useSpaceStore.getState().slice4d.playing).toBe(false);
    const t1 = useSpaceStore.getState().slice4d.tFrac;
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(useSpaceStore.getState().slice4d.tFrac).toBe(t1); // stopped
  });
});
