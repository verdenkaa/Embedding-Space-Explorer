/**
 * Pure coordinate-grid math (no three.js — unit-testable in jsdom).
 *
 * The 3D/4D scene draws points in "display" coordinates: the raw projection
 * coordinates centered and uniformly scaled into [-1, 1] (see selectionMath's
 * FitTransform). A numeric label at a display position on an axis must show
 * the REAL projection value there — obtained by inverting the fit
 * (raw = display · extent + center). The labels are therefore true
 * coordinates of the data, never invented numbers, and they stay correct
 * under zoom/orbit because they are anchored in world space.
 *
 * Layout (numbers mode): every principal axis carries BOTH its name (at the
 * positive end of the axis line) and its numeric ticks (along the axis line,
 * slightly offset so the sprite never sits on the line itself). Ticks use the
 * same "nice" 1/2/5·10^k steps as the 2D plots (makeTicks), so the printed
 * values have as many decimals as the step requires — never six.
 */

import { formatTick, makeTicks, type FitTransform } from "./selectionMath";

/** Display coordinate ([-1, 1]) → raw projection value along one axis. */
export function displayToRaw(display: number, fit: FitTransform, axis: number): number {
  return display * fit.extent + (fit.center[axis] ?? 0);
}

/** Raw projection value → display coordinate along one axis. */
export function rawToDisplay(raw: number, fit: FitTransform, axis: number): number {
  return (raw - (fit.center[axis] ?? 0)) / fit.extent;
}

/** Height of the floor grid plane in display units (matches PointScene). */
export const FLOOR_Y = -1.12;

/** Half-length of the principal-axis lines (a bit past the [-1, 1] cloud). */
export const AXIS_HALF = 1.15;

/** Where an axis name sits: at the positive end of its axis line (the Y name
 *  is offset left of the tip: on screen that side stays clear of the scene
 *  toolbar in the default camera view). */
export const AXIS_NAME_AT: readonly [number, number, number][] = [
  [1.32, 0, 0],
  [-0.26, 1.16, 0],
  [0, 0, 1.32],
];

/** Perpendicular offset of a tick sprite from its axis line. The three axes
 *  offset their ticks to DIFFERENT sides, so ticks near the crossing (where
 *  all three axis lines meet) never stack on top of each other. */
const TICK_OFFSET = 0.08;

/** Tick sprite position on one of the three axis lines. */
function tickPosition(axis: number, d: number): [number, number, number] {
  if (axis === 0) return [d, -TICK_OFFSET, 0]; // X: below its line
  if (axis === 1) return [-TICK_OFFSET - 0.02, d, 0]; // Y: left of its line
  return [0, TICK_OFFSET, d]; // Z: above its line
}

export interface GridLabel3D {
  text: string;
  position: [number, number, number];
  /** Axis-name labels are drawn slightly brighter than numeric ticks. */
  isAxisName: boolean;
}

/**
 * Numeric tick labels along each principal axis (real coordinate values at
 * evenly spaced "nice" steps) plus the axis-name labels at the positive axis
 * ends. `axisLabels` are the projection's real axis names (e.g. PC1/PC2/PC3,
 * UMAP1…, or raw axis indices) — a missing name is simply not drawn (no
 * invented label).
 */
export function gridLabels3D(fit: FitTransform, axisLabels: string[]): GridLabel3D[] {
  const out: GridLabel3D[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const lo = displayToRaw(-1, fit, axis);
    const hi = displayToRaw(1, fit, axis);
    const ticks = makeTicks(Math.min(lo, hi), Math.max(lo, hi));
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    for (const tick of ticks) {
      const d = rawToDisplay(tick, fit, axis);
      if (d < -1.02 || d > 1.02) continue;
      out.push({ text: formatTick(tick, step), position: tickPosition(axis, d), isAxisName: false });
    }
    const name = axisLabels[axis];
    if (name && name.length > 0) {
      out.push({ text: name, position: AXIS_NAME_AT[axis], isAxisName: true });
    }
  }
  return out;
}
