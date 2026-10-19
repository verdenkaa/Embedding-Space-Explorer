/**
 * Scene3D tests. The R3F Canvas cannot run in jsdom (no WebGL), so
 * @react-three/fiber and drei are mocked (same strategy as Monaco in
 * SourceInspector.test): we verify everything AROUND the canvas — states,
 * badge/legend honesty, toolbar wiring, tooltip, selection clearing, and
 * the Shift-held marquee model (no explicit mode buttons anymore) — while
 * the pure selection math is covered by selectionMath.test.ts.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import type { RelationsResponse } from "../../api/types";
import { useAnalysisStore } from "../../state/analysisStore";
import { useProjectStore } from "../../state/projectStore";
import { buildCloud, useSpaceStore } from "../../state/spaceStore";
import { Scene3D } from "./Scene3D";

const RELATIONS_AB: RelationsResponse = {
  items: [
    {
      id: "rel1",
      kind: "imports",
      origin: "extracted",
      confidence: 1,
      detail: null,
      created_at: "",
      source: {
        file_id: "fa",
        fragment_id: "fragA",
        rel_path: "src/a.py",
        name: "alpha",
        symbol_path: "Cls.alpha",
        start_line: 5,
        end_line: 9,
      },
      target: {
        file_id: "fb",
        fragment_id: "fragS",
        rel_path: "docs/guide.md",
        name: null,
        symbol_path: "Usage",
        start_line: 1,
        end_line: 4,
      },
    },
  ],
  total: 1,
  limit: 200,
  offset: 0,
  counts_by_kind: { imports: 1 },
  counts_by_origin: { extracted: 1 },
};

const RUN: ProjectionRunDTO = {
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
  versions: {},
  created_at: "",
  updated_at: "2026-10-15T12:00:00+00:00",
};

const POINTS: ProjectionPoints = {
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
      name: "alpha",
      symbol_path: "Cls.alpha",
      start_line: 5,
      end_line: 9,
      coords: [0.1, 0.2, 0.3],
    },
    {
      fragment_id: "fragS",
      file_id: "fb",
      rel_path: "docs/guide.md",
      kind: "section",
      name: null,
      symbol_path: "Usage",
      start_line: 1,
      end_line: 4,
      coords: [-0.4, 0.05, 0.2],
    },
  ],
};

function seedCloud(stale = false) {
  useSpaceStore.setState({
    cloud3d: buildCloud(POINTS, { ...RUN, stale }),
    loading3d: false,
    error: null,
    hoveredId: null,
    hoverScreen: null,
  });
}

beforeEach(() => {
  useAnalysisStore.getState().reset();
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
    pointSize: 3,
  });
});

afterEach(cleanup);

describe("Scene3D states", () => {
  it("empty state explains how to get a real cloud (no fake points)", () => {
    render(<Scene3D />);
    expect(screen.getByText(/3D-пространство пусто/)).toBeTruthy();
    expect(screen.getByText(/Постройте проекцию/)).toBeTruthy();
    expect(screen.getByText(/EXPERIMENTS/)).toBeTruthy();
  });

  it("loading state", () => {
    useSpaceStore.setState({ loading3d: true });
    render(<Scene3D />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/Загрузка координат проекции/)).toBeTruthy();
  });

  it("error state shows message and hint", () => {
    useSpaceStore.setState({
      error: {
        code: "projection_cache_unavailable",
        message: "Кэш координат повреждён.",
        hint: "Пересчитайте проекцию",
      },
    });
    render(<Scene3D />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Кэш координат повреждён.")).toBeTruthy();
    expect(screen.getByText("Пересчитайте проекцию")).toBeTruthy();
  });
});

describe("Scene3D with a cloud", () => {
  it("badge shows the projection identity and freshness honestly", () => {
    seedCloud(false);
    render(<Scene3D />);
    const badge = screen.getByText(/PCA · 3D · 2 точек/);
    expect(badge).toBeTruthy();
    expect(screen.getByText("свежая")).toBeTruthy();
  });

  it("stale projection is labeled, never silently shown as fresh", () => {
    seedCloud(true);
    render(<Scene3D />);
    expect(screen.getByText("устарела")).toBeTruthy();
    expect(screen.queryByText("свежая")).toBeNull();
  });

  it("legend lists kinds with counts and text badges (not color-only)", () => {
    seedCloud();
    render(<Scene3D />);
    const legend = screen.getByLabelText(/Легенда/);
    expect(legend.textContent).toContain("method");
    expect(legend.textContent).toContain("mth"); // kind badge text
    expect(legend.textContent).toContain("section");
    expect(legend.textContent).toContain("1"); // count per kind
  });

  it("legend is collapsible (many kinds can never cover the scene)", () => {
    seedCloud();
    render(<Scene3D />);
    const legend = screen.getByLabelText(/Легенда/);
    expect(legend.textContent).toContain("method");
    const toggle = screen.getByRole("button", { name: /Легенда/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByLabelText(/Легенда/).textContent).not.toContain("method");
    fireEvent.click(toggle);
    expect(screen.getByLabelText(/Легенда/).textContent).toContain("method");
  });

  it("has NO explicit interaction-mode buttons: Shift arms the marquee", () => {
    seedCloud();
    const { container } = render(<Scene3D />);
    // the old ⟲ Орбита / ▭ Область buttons are gone (user feedback): the
    // mode is transient — hold Shift, drag, release; orbit is the default.
    expect(screen.queryByRole("button", { name: /Область/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Орбита/ })).toBeNull();

    const scene = container.querySelector(".point-scene");
    expect(scene).toBeTruthy();
    expect(scene!.className).not.toContain("point-scene--marquee");

    // holding Shift arms the marquee (crosshair cursor via the class)
    fireEvent.keyDown(window, { key: "Shift" });
    expect(container.querySelector(".point-scene--marquee")).toBeTruthy();

    // Shift+drag draws the marquee rectangle overlay
    const target = scene!;
    fireEvent.pointerDown(target, { button: 0, shiftKey: true, clientX: 10, clientY: 10 });
    expect(container.querySelector(".marquee-rect")).toBeTruthy();
    fireEvent.pointerMove(target, { button: 0, shiftKey: true, clientX: 60, clientY: 50 });
    fireEvent.pointerUp(target, { button: 0, shiftKey: true, clientX: 60, clientY: 50 });
    expect(container.querySelector(".marquee-rect")).toBeNull();

    // releasing Shift returns to orbit mode
    fireEvent.keyUp(window, { key: "Shift" });
    expect(container.querySelector(".point-scene--marquee")).toBeNull();
  });

  it("a Shift-click without a drag never wipes the selection", () => {
    seedCloud();
    useProjectStore.setState({ selectedFragmentIds: ["fragA", "fragS"] });
    const { container } = render(<Scene3D />);
    const scene = container.querySelector(".point-scene")!;
    fireEvent.keyDown(window, { key: "Shift" });
    // degenerate marquee (pointer down+up in place, e.g. clicking a toolbar
    // button while Shift is held) — the old regression cleared everything
    fireEvent.pointerDown(scene, { button: 0, shiftKey: true, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(scene, { button: 0, shiftKey: true, clientX: 21, clientY: 20 });
    expect(useProjectStore.getState().selectedFragmentIds).toEqual(["fragA", "fragS"]);
  });

  it("selection survives returning to orbit (Shift released)", () => {
    seedCloud();
    useProjectStore.setState({ selectedFragmentIds: ["fragA"] });
    render(<Scene3D />);
    fireEvent.keyDown(window, { key: "Shift" });
    fireEvent.keyUp(window, { key: "Shift" });
    expect(useProjectStore.getState().selectedFragmentIds).toEqual(["fragA"]);
    expect(useProjectStore.getState().activeFragmentId).toBeNull();
  });

  it("clear-selection button resets the shared selection", () => {
    seedCloud();
    useProjectStore.setState({
      activeFragmentId: "fragA",
      selectedFragmentIds: ["fragA", "fragS"],
    });
    render(<Scene3D />);
    const clearBtn = screen.getByRole("button", { name: /Снять выделение \(2\)/ });
    fireEvent.click(clearBtn);
    const s = useProjectStore.getState();
    expect(s.selectedFragmentIds).toEqual([]);
    expect(s.activeFragmentId).toBeNull();
  });

  it("clear-selection is disabled when nothing is selected", () => {
    seedCloud();
    render(<Scene3D />);
    const clearBtn = screen.getByRole("button", { name: /Снять выделение/ });
    expect((clearBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("point size control clamps through the store", () => {
    seedCloud();
    render(<Scene3D />);
    const slider = screen.getByLabelText("Размер точек");
    fireEvent.change(slider, { target: { value: "6" } });
    expect(useSpaceStore.getState().pointSize).toBe(6);
  });

  it("hover tooltip shows fragment name, path and lines", () => {
    seedCloud();
    useSpaceStore.setState({
      hoveredId: "fragA",
      hoverScreen: { kind: "3d", x: 120, y: 90 },
    });
    render(<Scene3D />);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("alpha");
    expect(tooltip.textContent).toContain("src/a.py:5–9");
    expect(tooltip.textContent).toContain("mth");
  });

  it("Esc clears the selection from anywhere", () => {
    seedCloud();
    useProjectStore.setState({ selectedFragmentIds: ["fragA"] });
    render(<Scene3D />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useProjectStore.getState().selectedFragmentIds).toEqual([]);
  });
});


describe("Scene3D overlays", () => {
  it("«⇄ Связи» toggles relation lines and the filter panel lists kinds", () => {
    seedCloud();
    useProjectStore.setState({ activeFragmentId: "fragA" });
    useAnalysisStore.setState({
      fragmentRelations: RELATIONS_AB,
      fragmentRelationsFor: "fragA",
    });
    useSpaceStore.setState({ relationLines: true });
    render(<Scene3D />);

    const toggle = screen.getByRole("button", { name: /Связи/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    // the panel reports the single drawable line and its type filter
    expect(screen.getByText(/связи: 1/)).toBeTruthy();
    const kindBox = screen.getByRole("checkbox", { name: /imports/ });
    expect(kindBox).toBeTruthy();

    // unchecking the kind hides the line (count drops to 0 + explanation)
    fireEvent.click(kindBox);
    expect(screen.getByText(/нет связей с концами-фрагментами/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(useSpaceStore.getState().relationLines).toBe(false);
  });

  it("cluster coloring is disabled until labels are applied, then toggles", () => {
    seedCloud();
    render(<Scene3D />);
    const colorBtn = screen.getByRole("button", { name: /цвет: тип/ });
    expect((colorBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("with labels the color button switches the scene palette state", () => {
    seedCloud();
    useSpaceStore.setState({
      clusterLabels: new Map([
        ["fragA", 0],
        ["fragS", -1],
      ]),
      clusterCaption: "DBSCAN · исходное · cosine · кластеров: 1, шум: 1",
      colorBy: "kind",
    });
    render(<Scene3D />);
    const colorBtn = screen.getByRole("button", { name: /цвет: тип/ });
    expect((colorBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(colorBtn);
    expect(useSpaceStore.getState().colorBy).toBe("cluster");
    // the badge names the applied clustering (never a silent recolor)
    expect(screen.getByText(/DBSCAN · исходное/)).toBeTruthy();
  });

  it("slice «only» mode is reflected in the badge count", () => {
    seedCloud();
    useSpaceStore.setState({
      sliceOverlay: {
        embeddingRunId: "emb1",
        normalKind: "axis",
        normalIndex: 0,
        position: 0,
        thickness: 10,
        uMin: -1,
        uMax: 1,
        total: 2,
        uById: new Map([
          ["fragA", 0],
          ["fragS", 50],
        ]),
        note: "",
        vector: null,
        savedSliceId: null,
      },
      sliceDisplay: "only",
    });
    render(<Scene3D />);
    // window ±5 around 0 → fragA inside, fragS outside
    expect(screen.getByText(/слой: 1 из 2/)).toBeTruthy();
  });

  it("a slice of ANOTHER embedding run is not applied (no fake membership)", () => {
    seedCloud();
    useSpaceStore.setState({
      sliceOverlay: {
        embeddingRunId: "embOTHER",
        normalKind: "axis",
        normalIndex: 0,
        position: 0,
        thickness: 10,
        uMin: -1,
        uMax: 1,
        total: 2,
        uById: new Map(),
        note: "",
        vector: null,
        savedSliceId: null,
      },
      sliceDisplay: "only",
    });
    render(<Scene3D />);
    expect(screen.queryByText(/слой:/)).toBeNull();
  });
});
