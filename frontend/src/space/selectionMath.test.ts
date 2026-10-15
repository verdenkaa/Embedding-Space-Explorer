/**
 * selectionMath + palette unit tests: the picking/fit/tick math is pure and
 * must be exact — both views rely on it for hit-testing and marquee selection
 * (TZ §15.2: "параметры среза передаются без искажения" applies to view math
 * being deterministic and invertible).
 */

import { describe, expect, it } from "vitest";

import {
  applyFit,
  canvasToData,
  computeBounds2D,
  computeFit,
  dataToCanvas,
  formatTick,
  hitTest2D,
  indicesInDataRect,
  indicesInNdcRect,
  makeTicks,
  normalizeRect,
  type Padding,
  type PlotGeometry,
} from "./selectionMath";
import { buildLegend, hexToRgb, kindColor } from "./palette";

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
