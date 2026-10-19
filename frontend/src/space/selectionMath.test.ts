/**
 * selectionMath + palette unit tests: the picking/fit/tick math is pure and
 * must be exact — both views rely on it for hit-testing and marquee selection
 * ("параметры среза передаются без искажения" applies to view math
 * being deterministic and invertible).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  applyFit,
  applyFitStrided,
  axisExtent,
  canvasToData,
  computeBounds2D,
  computeFit,
  computeFitStrided,
  dataToCanvas,
  formatTick,
  hitTest2D,
  indicesInDataRect,
  indicesInNdcRect,
  layerMask4D,
  makeTicks,
  marqueeExceedsSlop,
  normalizeRect,
  panBounds,
  zoomBoundsAt,
  zoomLevel,
  type Padding,
  type PlotBounds,
  type PlotGeometry,
} from "./selectionMath";
import { buildLegend, buildLegendFrom, clusterColor, hexToRgb, kindColor } from "./palette";

const PAD: Padding = { left: 50, right: 10, top: 10, bottom: 30 };

describe("computeFit / applyFit", () => {
  it("fits a cloud into [-1, 1] keeping the aspect ratio", () => {
    // x spans [-2, 2], y spans [0, 1], z = 0 → extent = 2 (x half-span)
    const coords = new Float32Array([-2, 0, 0, 2, 1, 0, 0, 0.5, 0]);
    const fit = computeFit(coords, 3, 3);
    expect(fit.center).toEqual([0, 0.5, 0]);
    expect(fit.extent).toBe(2);
    const display = applyFit(coords, fit);
    for (let i = 0; i < display.length; i++) {
      expect(Math.abs(display[i])).toBeLessThanOrEqual(1 + 1e-6);
    }
    // the extreme x maps exactly to ±1
    expect(display[0]).toBeCloseTo(-1);
    expect(display[3]).toBeCloseTo(1);
  });

  it("degenerate cloud (single point) does not divide by zero", () => {
    const coords = new Float32Array([5, 7, 9]);
    const fit = computeFit(coords, 1, 3);
    expect(fit.extent).toBe(1);
    const display = applyFit(coords, fit);
    expect(Array.from(display)).toEqual([0, 0, 0]);
  });

  it("empty cloud yields a usable identity-ish fit", () => {
    const fit = computeFit(new Float32Array(0), 0, 3);
    expect(fit.center).toEqual([0, 0, 0]);
    expect(fit.extent).toBe(1);
  });
});

describe("rectangles & NDC selection", () => {
  it("normalizeRect is drag-direction agnostic", () => {
    expect(normalizeRect({ x0: 5, y0: 9, x1: -2, y1: 3 })).toEqual({
      x0: -2,
      y0: 3,
      x1: 5,
      y1: 9,
    });
  });

  it("indicesInNdcRect selects inside + border, ignores outside", () => {
    // points: (0,0) inside, (0.5,0.5) on border, (-0.9,0) outside
    const ndc = new Float32Array([0, 0, 0.5, 0.5, -0.9, 0]);
    expect(indicesInNdcRect(ndc, { x0: -0.5, y0: -0.5, x1: 0.5, y1: 0.5 })).toEqual([0, 1]);
  });

  it("indicesInDataRect works in data space (2D marquee)", () => {
    const coords = new Float32Array([0, 0, 10, 10, -5, 2]);
    expect(indicesInDataRect(coords, 3, { minX: -1, minY: -1, maxX: 11, maxY: 11 })).toEqual([
      0, 1,
    ]);
  });
});

describe("2D plot mapping", () => {
  it("dataToCanvas ↔ canvasToData round-trip", () => {
    const g: PlotGeometry = {
      width: 600,
      height: 300,
      padding: PAD,
      bounds: { minX: -2, maxX: 2, minY: -1, maxY: 3 },
    };
    for (const [x, y] of [
      [-2, -1],
      [0, 1],
      [1.5, 2.75],
    ]) {
      const { cx, cy } = dataToCanvas(x, y, g);
      const back = canvasToData(cx, cy, g);
      expect(back.x).toBeCloseTo(x, 5);
      expect(back.y).toBeCloseTo(y, 5);
    }
  });

  it("maps corners to the plot area and flips y", () => {
    const g: PlotGeometry = {
      width: 600,
      height: 300,
      padding: PAD,
      bounds: { minX: 0, maxX: 10, minY: 0, maxY: 10 },
    };
    const topLeft = dataToCanvas(0, 10, g);
    expect(topLeft).toEqual({ cx: PAD.left, cy: PAD.top });
    const bottomRight = dataToCanvas(10, 0, g);
    expect(bottomRight.cx).toBeCloseTo(600 - PAD.right);
    expect(bottomRight.cy).toBeCloseTo(300 - PAD.bottom);
  });

  it("computeBounds2D pads non-degenerate axes and rescues degenerate ones", () => {
    const coords = new Float32Array([0, 0, 10, 4]);
    const b = computeBounds2D(coords, 2);
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(10);
    expect(b.minY).toBeLessThan(0);
    expect(b.maxY).toBeGreaterThan(4);

    const single = computeBounds2D(new Float32Array([3, 3]), 1);
    expect(single.minX).toBeLessThan(3);
    expect(single.maxX).toBeGreaterThan(3);

    const empty = computeBounds2D(new Float32Array(0), 0);
    expect(empty).toEqual({ minX: -1, maxX: 1, minY: -1, maxY: 1 });
  });

  it("hitTest2D returns the nearest point within the radius only", () => {
    // pixels: (10,10), (50,50)
    const pixelOf = (i: number) => ({ cx: i === 0 ? 10 : 50, cy: i === 0 ? 10 : 50 });
    expect(hitTest2D(2, { cx: 12, cy: 9 }, 5, pixelOf)).toBe(0);
    expect(hitTest2D(2, { cx: 48, cy: 52 }, 5, pixelOf)).toBe(1);
    expect(hitTest2D(2, { cx: 30, cy: 30 }, 5, pixelOf)).toBeNull();
    expect(hitTest2D(0, { cx: 0, cy: 0 }, 5, pixelOf)).toBeNull();
  });
});

describe("ticks", () => {
  it("makeTicks covers the range with nice steps", () => {
    const ticks = makeTicks(0, 1, 5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks[0]).toBeGreaterThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(1);
    // uniform step
    const steps = ticks.slice(1).map((v, i) => v - ticks[i]);
    for (const s of steps) expect(s).toBeCloseTo(steps[0], 10);
  });

  it("makeTicks survives degenerate ranges", () => {
    expect(makeTicks(1, 1)).toEqual([]);
    expect(makeTicks(Number.NaN, 1)).toEqual([]);
  });

  it("formatTick: plain for normal magnitudes, exponential at the edges", () => {
    expect(formatTick(0, 0.5)).toBe("0");
    expect(formatTick(0.25, 0.25)).toBe("0.25");
    expect(formatTick(2.5, 0.5)).toBe("2.5");
    expect(formatTick(123456, 1)).toBe("1.2e+5");
    expect(formatTick(0.00001, 0.00001)).toBe("1.0e-5");
  });
});

describe("palette", () => {
  it("kind colors follow the corpus grouping", () => {
    expect(kindColor("function")).toBe(kindColor("method"));
    expect(kindColor("class")).toBe(kindColor("interface"));
    expect(kindColor("section")).toBe("#e8b45a");
    expect(kindColor("unknown-kind")).toBe(kindColor("chunk")); // gray fallback
  });

  it("hexToRgb converts to normalized triples", () => {
    expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    const [r, g, b] = hexToRgb("#45d6c5");
    expect(r).toBeCloseTo(0x45 / 255);
    expect(g).toBeCloseTo(0xd6 / 255);
    expect(b).toBeCloseTo(0xc5 / 255);
  });

  it("buildLegend counts kinds in a stable order", () => {
    const legend = buildLegend(["method", "class", "method", "chunk", "section"]);
    expect(legend.map((e) => e.kind)).toEqual(["method", "class", "section", "chunk"]);
    expect(legend[0].count).toBe(2);
  });
});


/* ------------------------------------------------------------------ */
/* strided fit, 4D layer, marquee slop, 2D zoom & pan */
/* ------------------------------------------------------------------ */

describe("computeFitStrided / applyFitStrided", () => {
  it("fits the first k of stride components (4D cloud → 3D scene)", () => {
    // two points, stride 4; the 4th column must not influence the fit
    const coords = new Float32Array([-1, 0, 2, 1000, 3, 4, -2, -1000]);
    const fit = computeFitStrided(coords, 2, 4, 3);
    expect(fit.center).toEqual([1, 2, 0]);
    expect(fit.extent).toBe(2); // largest half-extent among axes 0..2
    const display = applyFitStrided(coords, fit, 4, 3);
    expect(display).toHaveLength(6);
    expect(Array.from(display)).toEqual([-1, -1, 1, 1, 1, -1]);
  });

  it("k == stride degenerates to the classic fit", () => {
    const coords = new Float32Array([0, 0, 2, 4]);
    const fit = computeFitStrided(coords, 2, 2, 2);
    expect(fit).toEqual(computeFit(coords, 2, 2));
    expect(Array.from(applyFitStrided(coords, fit, 2, 2))).toEqual(
      Array.from(applyFit(coords, fit)),
    );
  });
});

describe("axisExtent", () => {
  it("reads min/max of one interleaved component", () => {
    const coords = new Float32Array([0, 0, 0, 5, 1, 1, 1, -3, 2, 2, 2, 9]);
    expect(axisExtent(coords, 3, 4, 3)).toEqual({ min: -3, max: 9 });
  });

  it("degenerate/empty input gives a zero range", () => {
    expect(axisExtent(new Float32Array(0), 0, 4, 3)).toEqual({ min: 0, max: 0 });
  });
});

describe("layerMask4D (the 4D 'time' window)", () => {
  // three points on axis 3: 0, 5, 10 (range 10)
  const coords = new Float32Array([
    0, 0, 0, 0,
    0, 0, 0, 5,
    0, 0, 0, 10,
  ]);

  it("keeps points inside [t ± w/2] and counts them", () => {
    // t = 0.5 → 5, window 0.4 → ±2 → only the middle point
    const layer = layerMask4D(coords, 3, 4, 3, 0.5, 0.4);
    expect(Array.from(layer.mask)).toEqual([0, 1, 0]);
    expect(layer.inLayer).toBe(1);
    expect(layer.t).toBeCloseTo(5);
    expect(layer.width).toBeCloseTo(4);
  });

  it("window edges are inclusive", () => {
    // t = 0.25 → 2.5, w = 0.5 → ±2.5 → points 0 and 5 both on the edge
    const layer = layerMask4D(coords, 3, 4, 3, 0.25, 0.5);
    expect(Array.from(layer.mask)).toEqual([1, 1, 0]);
  });

  it("full window covers everything; degenerate axis puts all in layer", () => {
    expect(layerMask4D(coords, 3, 4, 3, 0.5, 1).inLayer).toBe(3);
    const flat = new Float32Array([0, 0, 0, 7, 0, 0, 0, 7]);
    expect(layerMask4D(flat, 2, 4, 3, 0, 0).inLayer).toBe(2);
  });

  it("t/w fractions clamp into [0, 1]", () => {
    const layer = layerMask4D(coords, 3, 4, 3, 5, -2);
    expect(layer.t).toBe(10); // clamped to the max
    expect(layer.width).toBe(0); // clamped to 0 → only the exact edge point
    expect(Array.from(layer.mask)).toEqual([0, 0, 1]);
  });
});

describe("marqueeExceedsSlop", () => {
  it("separates a real drag from a click (the selection-wipe regression)", () => {
    expect(marqueeExceedsSlop({ x0: 0, y0: 0, x1: 0, y1: 0 }, 4)).toBe(false);
    expect(marqueeExceedsSlop({ x0: 10, y0: 10, x1: 12, y1: 11 }, 4)).toBe(false);
    expect(marqueeExceedsSlop({ x0: 10, y0: 10, x1: 15, y1: 10 }, 4)).toBe(true);
    expect(marqueeExceedsSlop({ x0: 10, y0: 10, x1: 10, y1: 4 }, 4)).toBe(true);
  });
});

describe("2D zoom & pan (bounds-space camera)", () => {
  const FIT: PlotBounds = { minX: -10, maxX: 10, minY: -5, maxY: 5 };
  const geom: PlotGeometry = { width: 400, height: 200, padding: PAD, bounds: FIT };

  it("zoomLevel: 1 at fit, 2 when the span halves", () => {
    expect(zoomLevel(FIT, FIT)).toBeCloseTo(1);
    const half: PlotBounds = { minX: -5, maxX: 5, minY: -2.5, maxY: 2.5 };
    expect(zoomLevel(half, FIT)).toBeCloseTo(2);
  });

  it("zoomBoundsAt keeps the anchor fixed and clamps to MIN/MAX_ZOOM", () => {
    const anchor = { x: 2, y: 1 };
    const zoomed = zoomBoundsAt(FIT, FIT, 2, anchor);
    // span halves around the anchor: anchor stays at the same fraction
    expect(zoomed.maxX - zoomed.minX).toBeCloseTo(10);
    const fracBefore = (anchor.x - FIT.minX) / (FIT.maxX - FIT.minX);
    const fracAfter = (anchor.x - zoomed.minX) / (zoomed.maxX - zoomed.minX);
    expect(fracAfter).toBeCloseTo(fracBefore);
    expect(zoomLevel(zoomed, FIT)).toBeCloseTo(2);

    // clamping: extreme zoom-in never exceeds MAX_ZOOM …
    let b = FIT;
    for (let i = 0; i < 40; i++) b = zoomBoundsAt(b, FIT, 3, anchor);
    expect(zoomLevel(b, FIT)).toBeLessThanOrEqual(MAX_ZOOM + 1e-9);
    // … and zooming out never shrinks below MIN_ZOOM (cloud stays reachable)
    let out = FIT;
    for (let i = 0; i < 40; i++) out = zoomBoundsAt(out, FIT, 1 / 3, anchor);
    expect(zoomLevel(out, FIT)).toBeGreaterThanOrEqual(MIN_ZOOM - 1e-9);
  });

  it("panBounds moves the content with the cursor", () => {
    // plot area: 400 - 50 - 10 = 340 px wide for a 20-unit span
    const panned = panBounds(FIT, 34, 0, geom);
    expect(panned.minX).toBeCloseTo(-12); // dragged right → view shifts left
    expect(panned.maxX).toBeCloseTo(8);
    // vertical: canvas y grows down, data y grows up (160 px plot = 10 units)
    const pannedY = panBounds(FIT, 0, 16, geom);
    expect(pannedY.minY).toBeCloseTo(-4);
    expect(pannedY.maxY).toBeCloseTo(6);
  });

  it("zoom → data → canvas round-trip stays consistent (hit-testing)", () => {
    const zoomed = zoomBoundsAt(FIT, FIT, 4, { x: 0, y: 0 });
    const g: PlotGeometry = { ...geom, bounds: zoomed };
    const data = { x: 3.5, y: -1.25 };
    const px = dataToCanvas(data.x, data.y, g);
    const back = canvasToData(px.cx, px.cy, g);
    expect(back.x).toBeCloseTo(data.x, 5);
    expect(back.y).toBeCloseTo(data.y, 5);
  });
});


describe("cluster palette", () => {
  it("labels get deterministic, distinct colors; noise is the neutral gray", () => {
    expect(clusterColor(0)).toBe(clusterColor(0));
    expect(clusterColor(1)).not.toBe(clusterColor(2));
    expect(clusterColor(-1)).toBe("#8fa0ae");
    // colors stay in the readable band (not near-black on the dark bg)
    for (const label of [0, 1, 2, 3, 5, 8, 13, 21]) {
      const hex = clusterColor(label);
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      expect(Math.max(r, g, b)).toBeGreaterThan(90);
    }
  });

  it("buildLegendFrom counts arbitrary keys with their colors", () => {
    const legend = buildLegendFrom(["кластер 0", "шум", "кластер 0"], (key) =>
      key === "шум" ? "#8fa0ae" : "#123456",
    );
    expect(legend).toEqual([
      { kind: "кластер 0", color: "#123456", count: 2 },
      { kind: "шум", color: "#8fa0ae", count: 1 },
    ]);
  });
});
