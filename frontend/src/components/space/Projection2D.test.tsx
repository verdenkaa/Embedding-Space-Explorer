/**
 * Projection2D tests. jsdom has no canvas backend — getContext is stubbed
 * with a recorder; geometry/hit-testing logic is verified through real
 * pointer events using coordinates computed with the SAME pure helpers the
 * component uses (no magic numbers). Stage-3 polish adds: several plots
 * side by side, wheel zoom + drag pan, and the point-size slider.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectionPoints, ProjectionRunDTO } from "../../api/types";
import {
  DEFAULT_PADDING,
  computeBounds2D,
  dataToCanvas,
  type PlotGeometry,
} from "../../space/selectionMath";
import { useProjectStore } from "../../state/projectStore";
import { buildCloud, useSpaceStore } from "../../state/spaceStore";
import { Projection2D } from "./Projection2D";

const WIDTH = 600;
const HEIGHT = 300;

const RUN: ProjectionRunDTO = {
  id: "proj2d",
  embedding_run_id: "emb1",
  method: "pca",
  method_display_name: "PCA",
  n_components: 2,
  params: { whiten: false },
  seed: 42,
  axis_labels: ["PC1", "PC2"],
  axis_info: [0.62, 0.24],
  count: 3,
  stale: false,
  cache_ok: true,
  versions: {},
  created_at: "",
  updated_at: "2026-10-15T12:00:00+00:00",
};

function pointsDTO(overrides: Partial<ProjectionPoints> = {}): ProjectionPoints {
  return {
    projection_id: "proj2d",
    method: "pca",
    method_display_name: "PCA",
    n_components: 2,
    axis_labels: ["PC1", "PC2"],
    axis_info: [0.62, 0.24],
    stale: false,
    count: 3,
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
        coords: [0, 0],
      },
      {
        fragment_id: "fragB",
        file_id: "fa",
        rel_path: "src/a.py",
        kind: "class",
        name: "Beta",
        symbol_path: "Beta",
        start_line: 20,
        end_line: 40,
        coords: [4, 2],
      },
      {
        fragment_id: "fragC",
        file_id: "fa",
        rel_path: "src/a.py",
        kind: "section",
        name: null,
        symbol_path: "Docs > Usage",
        start_line: 1,
        end_line: 3,
        coords: [-4, -2],
      },
    ],
    ...overrides,
  };
}

/** Pixel position of point i exactly as the component computes it. */
function pixelOf(i: number, dto: ProjectionPoints): { cx: number; cy: number } {
  const coords = new Float32Array(dto.points.flatMap((p) => p.coords));
  const bounds = computeBounds2D(coords, dto.points.length);
  const geom: PlotGeometry = { width: WIDTH, height: HEIGHT, padding: DEFAULT_PADDING, bounds };
  return dataToCanvas(dto.points[i].coords[0], dto.points[i].coords[1], geom);
}

function stubCanvasContext() {
  const recorded: string[] = [];
  const handler: ProxyHandler<object> = {
    get(_target, prop: string) {
      if (prop === "setLineDash") return () => undefined;
      if (
        [
          "strokeStyle",
          "fillStyle",
          "lineWidth",
          "font",
          "textAlign",
          "globalAlpha",
          "textBaseline",
        ].includes(prop)
      ) {
        return "";
      }
      return (..._args: unknown[]) => {
        recorded.push(prop);
      };
    },
    set() {
      return true;
    },
  };
  const ctx = new Proxy({}, handler);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  return recorded;
}

function cloudOf(
  dto: ProjectionPoints = pointsDTO(),
  run: ProjectionRunDTO = RUN,
) {
  return buildCloud(dto, { ...run, stale: dto.stale });
}

function seedClouds(
  dto: ProjectionPoints = pointsDTO(),
  run: ProjectionRunDTO = RUN,
) {
  useSpaceStore.setState({
    clouds2d: [cloudOf(dto, run)],
    loading2d: false,
    error: null,
    hoveredId: null,
    hoverScreen: null,
  });
}

class ResizeObserverStub {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: {} as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // jsdom lacks ResizeObserver and reports zero sizes.
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => WIDTH,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => HEIGHT,
  });
  stubCanvasContext();
  useProjectStore.setState({
    current: { id: "p1", name: "Sample" } as never,
    selectedFileId: "fa", // same file as the points → no fetch on select
    fileDetail: null,
    fileContent: null,
    activeFragmentId: null,
    selectedFragmentIds: [],
    error: null,
  });
  useSpaceStore.setState({
    clouds2d: [],
    loading2d: false,
    error: null,
    hoveredId: null,
    hoverScreen: null,
    pointSize: 4,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
});

describe("Projection2D", () => {
  it("shows an honest empty state when no projection is loaded", () => {
    useSpaceStore.setState({ clouds2d: [], loading2d: false });
    render(<Projection2D />);
    expect(screen.getByText(/2D-проекция появится/)).toBeTruthy();
    expect(screen.getByText(/0,1;0,2/)).toBeTruthy(); // multi-plot hint
  });

  it("plot header names the method, axes, explained variance and staleness", () => {
    seedClouds(pointsDTO({ stale: true }), { ...RUN, stale: true });
    render(<Projection2D />);
    expect(screen.getByText(/PCA · 3 точ\./)).toBeTruthy();
    expect(screen.getByText(/оси: PC1 \/ PC2 \(62% \/ 24% дисперсии\)/)).toBeTruthy();
    expect(screen.getByText("устарела")).toBeTruthy();
    // the projection-vs-slice distinction is always visible (TZ §5.4)
    expect(screen.getByText("проекция всех точек · не срез")).toBeTruthy();
  });

  it("draws points, axes and selection marks on the canvas", () => {
    const recorded = stubCanvasContext();
    seedClouds();
    useProjectStore.setState({ selectedFragmentIds: ["fragB"], activeFragmentId: "fragA" });
    render(<Projection2D />);
    // frame + ticks + point glyphs + rings were actually painted
    expect(recorded).toContain("strokeRect");
    expect(recorded).toContain("fillRect");
    expect(recorded).toContain("arc");
    expect(recorded).toContain("fillText");
  });

  it("click on a point selects it and syncs the shared selection state", async () => {
    const dto = pointsDTO();
    seedClouds(dto);
    render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });

    const { cx, cy } = pixelOf(1, dto); // fragB
    fireEvent.pointerDown(canvas, { clientX: cx, clientY: cy, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: cx, clientY: cy, button: 0 });

    await waitFor(() => {
      const s = useProjectStore.getState();
      expect(s.activeFragmentId).toBe("fragB");
      expect(s.selectedFragmentIds).toEqual(["fragB"]);
    });
  });

  it("click on empty space clears the selection", async () => {
    seedClouds();
    useProjectStore.setState({ activeFragmentId: "fragA", selectedFragmentIds: ["fragA"] });
    render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });

    // a corner far from any point
    fireEvent.pointerDown(canvas, { clientX: 2, clientY: 2, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 2, clientY: 2, button: 0 });

    await waitFor(() => {
      const s = useProjectStore.getState();
      expect(s.activeFragmentId).toBeNull();
      expect(s.selectedFragmentIds).toEqual([]);
    });
  });

  it("hover over a point publishes the hovered fragment id", async () => {
    const dto = pointsDTO();
    seedClouds(dto);
    render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });

    const { cx, cy } = pixelOf(0, dto); // fragA
    fireEvent.pointerMove(canvas, { clientX: cx, clientY: cy });

    await waitFor(() => {
      expect(useSpaceStore.getState().hoveredId).toBe("fragA");
      expect(useSpaceStore.getState().hoverScreen?.kind).toBe("2d");
    });
    // tooltip shows name + path + lines (UI-ТЗ §3)
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText(/src\/a\.py:5–9/)).toBeTruthy();
  });

  it("shift+drag marquee selects every point inside the rectangle", async () => {
    const dto = pointsDTO();
    seedClouds(dto);
    render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });

    const a = pixelOf(0, dto); // fragA (0,0)
    const b = pixelOf(1, dto); // fragB (4,2)
    const x0 = Math.min(a.cx, b.cx) - 6;
    const y0 = Math.min(a.cy, b.cy) - 6;
    const x1 = Math.max(a.cx, b.cx) + 6;
    const y1 = Math.max(a.cy, b.cy) + 6;

    fireEvent.pointerDown(canvas, { clientX: x0, clientY: y0, button: 0, shiftKey: true });
    fireEvent.pointerMove(canvas, { clientX: x1, clientY: y1, shiftKey: true });
    fireEvent.pointerUp(canvas, { clientX: x1, clientY: y1, shiftKey: true });

    await waitFor(() => {
      const selected = useProjectStore.getState().selectedFragmentIds;
      expect(selected).toContain("fragA");
      expect(selected).toContain("fragB");
      expect(selected).not.toContain("fragC"); // opposite corner, outside
    });
  });

  it("a shift-click without a drag never touches the selection", () => {
    seedClouds();
    useProjectStore.setState({ selectedFragmentIds: ["fragA"] });
    render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, button: 0, shiftKey: true });
    fireEvent.pointerUp(canvas, { clientX: 6, clientY: 5, button: 0, shiftKey: true });
    expect(useProjectStore.getState().selectedFragmentIds).toEqual(["fragA"]);
  });

  it("ctrl+drag marquee ADDS the area to the current selection", async () => {
    const dto = pointsDTO();
    seedClouds(dto);
    useProjectStore.setState({ selectedFragmentIds: ["fragC"] });
    render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });

    const a = pixelOf(0, dto); // fragA only
    fireEvent.pointerDown(canvas, {
      clientX: a.cx - 5,
      clientY: a.cy - 5,
      button: 0,
      shiftKey: true,
      ctrlKey: true,
    });
    fireEvent.pointerMove(canvas, { clientX: a.cx + 5, clientY: a.cy + 5, ctrlKey: true });
    fireEvent.pointerUp(canvas, { clientX: a.cx + 5, clientY: a.cy + 5, ctrlKey: true });

    await waitFor(() => {
      const selected = useProjectStore.getState().selectedFragmentIds;
      expect(selected).toContain("fragC"); // previous selection kept
      expect(selected).toContain("fragA"); // area added
      expect(selected).not.toContain("fragB");
    });
  });
});

describe("Projection2D camera and multi-plot", () => {
  it("has a point-size slider wired to the shared store value", () => {
    seedClouds();
    render(<Projection2D />);
    const slider = screen.getByLabelText("Размер точек");
    fireEvent.change(slider, { target: { value: "7" } });
    expect(useSpaceStore.getState().pointSize).toBe(7);
  });

  it("wheel zooms the view and ⌂ returns to the auto-fit", async () => {
    seedClouds();
    render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });
    expect(screen.getByText("100%")).toBeTruthy();

    fireEvent.wheel(canvas, { deltaY: -240, clientX: 300, clientY: 150 });
    await waitFor(() => {
      expect(screen.queryByText("100%")).toBeNull(); // zoomed in past the fit
    });

    const reset = screen.getByRole("button", { name: "⌂" });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reset);
    expect(screen.getByText("100%")).toBeTruthy();
    expect((reset as HTMLButtonElement).disabled).toBe(true);
  });

  it("drag without Shift pans (content follows the cursor)", () => {
    seedClouds();
    const { container } = render(<Projection2D />);
    const canvas = screen.getByRole("img", { name: /2D-проекция/ });

    fireEvent.pointerDown(canvas, { clientX: 300, clientY: 150, button: 0 });
    expect(container.querySelector(".plot2d--panning")).toBeTruthy();
    fireEvent.pointerMove(canvas, { clientX: 260, clientY: 130, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 260, clientY: 130, button: 0 });
    expect(container.querySelector(".plot2d--panning")).toBeNull();
    // panning is not a click: the selection stays untouched
    expect(useProjectStore.getState().selectedFragmentIds).toEqual([]);
  });

  it("several clouds render several plots side by side", () => {
    const dtoA = pointsDTO({ projection_id: "pA" });
    const dtoB = pointsDTO({ projection_id: "pB" });
    const runA = { ...RUN, id: "pA", axis_labels: ["dim 0", "dim 1"] };
    const runB = { ...RUN, id: "pB", axis_labels: ["dim 0", "dim 2"] };
    useSpaceStore.setState({ clouds2d: [cloudOf(dtoA, runA), cloudOf(dtoB, runB)] });
    render(<Projection2D />);

    expect(screen.getByText(/2 графика рядом/)).toBeTruthy();
    expect(screen.getAllByRole("img", { name: /2D-проекция/ })).toHaveLength(2);
    expect(screen.getByText(/оси: dim 0 \/ dim 1/)).toBeTruthy();
    expect(screen.getByText(/оси: dim 0 \/ dim 2/)).toBeTruthy();
    // each plot has its own zoom reset
    expect(screen.getAllByRole("button", { name: "⌂" })).toHaveLength(2);
  });
});
