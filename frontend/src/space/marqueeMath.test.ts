/**
 * marqueeMath tests (audit fix #11): points behind the camera must never be
 * marquee-selected — the perspective divide mirrors them into the NDC range,
 * so the depth check happens in view space before projecting.
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { indicesInNdcRect, normalizeRect } from "./selectionMath";
import { marqueeNdc } from "./marqueeMath";

function makeCamera(): THREE.PerspectiveCamera {
  // the scene camera: fov 50, near 0.01, sitting at (0, 0, 5) looking at -z
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 60);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

describe("marqueeNdc", () => {
  it("projects points in front of the camera into finite NDC", () => {
    const camera = makeCamera();
    // one point at the origin (5 units in front), display buffer stride 3
    const display = new Float32Array([0, 0, 0]);
    const ndc = marqueeNdc(display, [0], camera);
    expect(Number.isFinite(ndc[0])).toBe(true);
    expect(Number.isFinite(ndc[1])).toBe(true);
    expect(Math.abs(ndc[0])).toBeLessThan(1e-6); // centered on the view axis
    expect(Math.abs(ndc[1])).toBeLessThan(1e-6);
  });

  it("marks points behind the camera as NaN — the old projection mirrored them INTO the rect", () => {
    const camera = makeCamera();
    // (0.2, 0.1, 6) is 1 unit BEHIND the camera; a plain Vector3.project
    // maps it to roughly (-0.43, -0.21) — inside a centered marquee rect.
    const display = new Float32Array([0.2, 0.1, 6]);
    const mirrored = new THREE.Vector3(0.2, 0.1, 6).project(camera);
    const rect = normalizeRect({ x0: -0.5, y0: -0.5, x1: 0.5, y1: 0.5 });
    // sanity: the unguarded projection really lands inside the rect
    expect(mirrored.x).toBeGreaterThan(rect.x0);
    expect(mirrored.x).toBeLessThan(rect.x1);
    expect(mirrored.y).toBeGreaterThan(rect.y0);
    expect(mirrored.y).toBeLessThan(rect.y1);

    const ndc = marqueeNdc(display, [0], camera);
    expect(Number.isNaN(ndc[0])).toBe(true);
    expect(Number.isNaN(ndc[1])).toBe(true);
    expect(indicesInNdcRect(ndc, rect)).toEqual([]); // never selected
  });

  it("handles mixed visible slots and keeps slot alignment", () => {
    const camera = makeCamera();
    // slot 0 → point index 2 (in front), slot 1 → point index 0 (behind)
    const display = new Float32Array([0, 0, 6, 1, 1, 6, 0.3, 0, 0]);
    const ndc = marqueeNdc(display, [2, 0], camera);
    expect(Number.isFinite(ndc[0])).toBe(true);
    expect(Number.isNaN(ndc[2])).toBe(true);
  });
});
