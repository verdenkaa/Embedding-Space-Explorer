/**
 * gridMath tests: the 3D floor-grid numeric labels must show REAL projection
 * coordinates (inverting the display fit), never invented numbers, and only
 * for axes the projection actually names.
 */

import { describe, expect, it } from "vitest";

import { FLOOR_LABEL_POSITIONS, FLOOR_Y, displayToRaw, floorGridLabels } from "./gridMath";
import type { FitTransform } from "./selectionMath";

const FIT: FitTransform = { center: [10, 20, 30], extent: 2 };

describe("displayToRaw (inverse of the view fit)", () => {
  it("maps display [-1,1] back to raw projection units", () => {
    expect(displayToRaw(0, FIT, 0)).toBe(10);
    expect(displayToRaw(1, FIT, 0)).toBe(12);
    expect(displayToRaw(-1, FIT, 1)).toBe(18);
    expect(displayToRaw(0.5, FIT, 2)).toBe(31);
  });
});

describe("floorGridLabels", () => {
  it("labels the floor X and Z axes with real coordinate values", () => {
    const labels = floorGridLabels(FIT, ["PC1", "PC2", "PC3"]);
    const numeric = labels.filter((l) => !l.isAxisName);
    // five labeled positions on each of the two floor axes
    expect(numeric).toHaveLength(FLOOR_LABEL_POSITIONS.length * 2);
    for (const l of numeric) {
      expect(l.text.length).toBeGreaterThan(0);
      expect(l.position[1]).toBe(FLOOR_Y); // all on the floor plane
    }
    // X axis spans component 0 (center 10, extent 2 → 8…12); Z spans 28…32
    const texts = numeric.map((l) => l.text);
    expect(texts).toContain("8");
    expect(texts).toContain("10");
    expect(texts).toContain("12");
    expect(texts).toContain("28");
    expect(texts).toContain("32");
  });

  it("adds the projection's real axis names, brighter than ticks", () => {
    const names = floorGridLabels(FIT, ["PC1", "PC2", "PC3"]).filter((l) => l.isAxisName);
    expect(names.map((n) => n.text)).toEqual(["PC1", "PC2", "PC3"]);
  });

  it("omits axis names the projection does not provide (no invented labels)", () => {
    const labels = floorGridLabels(FIT, []);
    expect(labels.some((l) => l.isAxisName)).toBe(false);
    // numeric ticks are still drawn
    expect(labels.filter((l) => !l.isAxisName)).toHaveLength(FLOOR_LABEL_POSITIONS.length * 2);
  });
});
