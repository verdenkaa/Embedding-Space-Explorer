/**
 * Pure coordinate-grid math (no three.js — unit-testable in jsdom).
 *
 * The 3D/4D scene draws points in "display" coordinates: the raw projection
 * coordinates centered and uniformly scaled into [-1, 1] (see selectionMath's
 * FitTransform). The floor grid lives at a fixed display height, so a numeric
 * label at a display position must show the REAL projection value there —
 * obtained by inverting the fit (raw = display · extent + center). The labels
 * are therefore true coordinates of the data, never invented numbers, and they
 * stay correct under zoom/orbit because they are anchored in world space.
 */

import { formatTick, type FitTransform } from "./selectionMath";

/** Display coordinate ([-1, 1]) → raw projection value along one axis. */
export function displayToRaw(display: number, fit: FitTransform, axis: number): number {
  return display * fit.extent + (fit.center[axis] ?? 0);
}

/** Display positions along each floor axis that receive a numeric label. */
export const FLOOR_LABEL_POSITIONS: readonly number[] = [-1, -0.5, 0, 0.5, 1];

/** Height of the floor grid plane in display units (matches PointScene). */
export const FLOOR_Y = -1.12;

export interface GridLabel3D {
  text: string;
  position: [number, number, number];
  /** Axis-name labels are drawn slightly brighter than numeric ticks. */
  isAxisName: boolean;
}

/**
 * Numeric tick labels along the floor X (component 0) and Z (component 2)
 * axes, plus the axis-name labels at the positive axis ends. `axisLabels`
 * are the projection's real axis names (e.g. PC1/PC2/PC3, UMAP1…, or raw
 * axis indices) — a missing name is simply not drawn (no invented label).
 */
export function floorGridLabels(fit: FitTransform, axisLabels: string[]): GridLabel3D[] {
  const step = 0.5 * fit.extent; // raw distance between two labeled display ticks
  const out: GridLabel3D[] = [];
  for (const d of FLOOR_LABEL_POSITIONS) {
    out.push({
      text: formatTick(displayToRaw(d, fit, 0), step),
      position: [d, FLOOR_Y, 1.12],
      isAxisName: false,
    });
    out.push({
      text: formatTick(displayToRaw(d, fit, 2), step),
      position: [1.12, FLOOR_Y, d],
      isAxisName: false,
    });
  }
  const name = (i: number): string | null => {
    const v = axisLabels[i];
    return v && v.length > 0 ? v : null;
  };
  const ax0 = name(0);
  const ax1 = name(1);
  const ax2 = name(2);
  if (ax0) out.push({ text: ax0, position: [1.32, FLOOR_Y, 1.12], isAxisName: true });
  if (ax1) out.push({ text: ax1, position: [0, 1.28, 0], isAxisName: true });
  if (ax2) out.push({ text: ax2, position: [1.12, FLOOR_Y, -1.32], isAxisName: true });
  return out;
}
