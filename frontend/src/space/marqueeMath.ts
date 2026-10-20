/**
 * Marquee projection math for the 3D scene (audit fix #11).
 *
 * `Vector3.project(camera)` performs the perspective divide unconditionally:
 * points BEHIND the camera come out MIRRORED into the [-1, 1] NDC range and
 * can land inside the drag rectangle even though nothing is drawn there —
 * with `minDistance` well inside the cloud radius the camera routinely ends
 * up inside the cloud, so the old code silently selected invisible points.
 * This module splits the projection into view-space and clip-space steps and
 * marks everything not strictly in front of the near plane as NaN (NaN fails
 * every range comparison in `indicesInNdcRect`, so such points are excluded
 * without changing the selection code).
 *
 * NOTE: the marquee still selects OCCLUDED points (it is a volumetric
 * selection through the cloud, not a screen-visible-pixels selection) —
 * that is intended behavior and is stated in the toolbar hint.
 */

import * as THREE from "three";

/**
 * Project display-space points into NDC for marquee hit-testing.
 * Returns an interleaved (x, y) Float32Array over `visible` slots; slots
 * behind the camera hold NaN. `camera.matrixWorld*` must be current —
 * call `camera.updateMatrixWorld()` first (the render loop does).
 */
export function marqueeNdc(
  display: Float32Array,
  visible: ArrayLike<number>,
  camera: THREE.Camera,
): Float32Array {
  const near = camera instanceof THREE.PerspectiveCamera ? camera.near : 0;
  const ndc = new Float32Array(visible.length * 2);
  const v = new THREE.Vector3();
  for (let slot = 0; slot < visible.length; slot++) {
    const orig = visible[slot];
    v.set(display[orig * 3], display[orig * 3 + 1], display[orig * 3 + 2]);
    // view space: in front of the camera means z <= -near
    v.applyMatrix4(camera.matrixWorldInverse);
    if (v.z > -near) {
      ndc[slot * 2] = Number.NaN;
      ndc[slot * 2 + 1] = Number.NaN;
      continue;
    }
    v.applyMatrix4(camera.projectionMatrix);
    ndc[slot * 2] = v.x;
    ndc[slot * 2 + 1] = v.y;
  }
  return ndc;
}
