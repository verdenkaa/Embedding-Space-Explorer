/**
 * gridMath tests: the 3D axis labels must show REAL projection coordinates
 * (inverting the display fit) at evenly spaced "nice" steps, never invented
 * numbers and never six-decimal noise; every axis carries both its name and
 * its ticks; only axes the projection actually names get a name label.
 */

import { describe, expect, it } from "vitest";

import {
  AXIS_HALF,
  AXIS_NAME_AT,
  FLOOR_Y,
  displayToRaw,
  gridLabels3D,
  rawToDisplay,
} from "./gridMath";
import type { FitTransform } from "./selectionMath";

const FIT: FitTransform = { center: [10, 20, 30], extent: 2 };

describe("displayToRaw / rawToDisplay (inverse of the view fit)", () => {
  it("maps display [-1,1] back to raw projection units", () => {
    expect(displayToRaw(0, FIT, 0)).toBe(10);
    expect(displayToRaw(1, FIT, 0)).toBe(12);
    expect(displayToRaw(-1, FIT, 1)).toBe(18);
    expect(displayToRaw(0.5, FIT, 2)).toBe(31);
  });

  it("round-trips raw → display → raw", () => {
    for (const axis of [0, 1, 2]) {
      const d = rawToDisplay(11.5, FIT, axis);
      expect(displayToRaw(d, FIT, axis)).toBeCloseTo(11.5, 10);
    }
  });
});

describe("gridLabels3D", () => {
  it("labels every axis with real coordinate values at nice steps", () => {
    const labels = gridLabels3D(FIT, ["PC1", "PC2", "PC3"]);
    const numeric = labels.filter((l) => !l.isAxisName);
    // axis 0 spans 8..12, axis 1 spans 18..22, axis 2 spans 28..32:
    // makeTicks picks step 1 → five ticks per axis
    expect(numeric).toHaveLength(15);
    for (const l of numeric) {
      expect(l.text.length).toBeGreaterThan(0);
      // step 1 → no decimals at all (never 3.518955-style noise)
      expect(l.text).not.toContain(".");
    }
    const texts = numeric.map((l) => l.text);
    expect(texts).toContain("8");
    expect(texts).toContain("12");
    expect(texts).toContain("20");
    expect(texts).toContain("28");
    expect(texts).toContain("32");
  });

  it("puts ticks ON their own axis line (x/y/z) inside the cloud box", () => {
    const numeric = gridLabels3D(FIT, []).filter((l) => !l.isAxisName);
    for (const l of numeric) {
      const [x, y, z] = l.position;
      const onAxisX = Math.abs(y + 0.08) < 1e-9 && z === 0 && Math.abs(x) <= 1.02;
      const onAxisY = Math.abs(x + 0.1) < 1e-9 && z === 0 && Math.abs(y) <= 1.02;
      const onAxisZ = Math.abs(y - 0.08) < 1e-9 && x === 0 && Math.abs(z) <= 1.02;
      expect(onAxisX || onAxisY || onAxisZ).toBe(true);
    }
  });

  it("keeps the zero tick once per axis, on non-colliding sides", () => {
    const zeroFit: FitTransform = { center: [0, 0, 0], extent: 1 };
    const numeric = gridLabels3D(zeroFit, []).filter((l) => !l.isAxisName);
    // ticks -1, -0.5, 0, 0.5, 1 per axis
    expect(numeric).toHaveLength(15);
    const zeros = numeric.filter((l) => l.text === "0");
    expect(zeros).toHaveLength(3);
    // …and the three zeros sit at three DIFFERENT positions
    const pos = zeros.map((l) => l.position.join(","));
    expect(new Set(pos).size).toBe(3);
  });

  it("names each axis at the positive end of its line", () => {
    const names = gridLabels3D(FIT, ["PC1", "PC2", "PC3"]).filter((l) => l.isAxisName);
    expect(names.map((n) => n.text)).toEqual(["PC1", "PC2", "PC3"]);
    expect(names.map((n) => n.position)).toEqual([
      AXIS_NAME_AT[0],
      AXIS_NAME_AT[1],
      AXIS_NAME_AT[2],
    ]);
    // names sit at the positive ends of their axis lines (Y: beside the tip)
    for (const pos of names.map((n) => n.position)) {
      const end = Math.max(Math.abs(pos[0]), Math.abs(pos[1]), Math.abs(pos[2]));
      expect(end).toBeGreaterThan(1.0);
      expect(end).toBeLessThan(AXIS_HALF + 0.3);
    }
  });

  it("omits axis names the projection does not provide (no invented labels)", () => {
    const labels = gridLabels3D(FIT, []);
    expect(labels.some((l) => l.isAxisName)).toBe(false);
    // numeric ticks are still drawn
    expect(labels.filter((l) => !l.isAxisName).length).toBeGreaterThan(0);
  });

  it("keeps the floor grid plane constant for the scene", () => {
    expect(FLOOR_Y).toBe(-1.12);
  });
});
