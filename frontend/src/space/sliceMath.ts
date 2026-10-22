/**
 * Slice overlay math for the views (pure, unit-tested).
 *
 * The backend computes the signed coordinate u(x) = dot(x - centroid, n) of
 * EVERY fragment along the slice normal and serves the array once per
 * (run, normal); position/thickness sliders then re-mask client-side without
 * round-trips. Membership matches the backend formula exactly:
 * |u - position| <= thickness / 2 (inclusive boundaries).
 *
 * A slice is defined on an embedding run; it is applied to a cloud only when
 * the cloud's projection was built from the SAME run (honesty: membership of
 * vectors from another run is undefined — the views say so instead of
 * guessing).
 */

export interface SliceWindow {
  position: number;
  thickness: number;
}

export function inLayer(u: number, sliceWindow: SliceWindow): boolean {
  return Math.abs(u - sliceWindow.position) <= sliceWindow.thickness / 2;
}

export interface CloudSliceMask {
  /** 1 = inside the layer, 0 = outside (aligned with cloud point indices). */
  mask: Uint8Array;
  inLayer: number;
  /** Points whose fragment has no u value (another embedding run). */
  unknown: number;
}

/**
 * Build the per-point layer mask for a cloud from the served u map.
 * Fragments missing from the map count as OUTSIDE the layer (and are
 * counted separately so the UI can be honest about partial coverage).
 */
export function cloudSliceMask(
  fragmentIds: ArrayLike<string>,
  uById: Map<string, number>,
  sliceWindow: SliceWindow,
): CloudSliceMask {
  const mask = new Uint8Array(fragmentIds.length);
  let inside = 0;
  let unknown = 0;
  for (let i = 0; i < fragmentIds.length; i++) {
    const u = uById.get(fragmentIds[i]);
    if (u === undefined) {
      unknown += 1;
      continue;
    }
    if (inLayer(u, sliceWindow)) {
      mask[i] = 1;
      inside += 1;
    }
  }
  return { mask, inLayer: inside, unknown };
}

/* ------------------------------------------------------------------ */
/* View integration: masks per display mode */
/* ------------------------------------------------------------------ */

/** What the scenes need from a slice overlay (structural — no store import). */
export interface SliceSource {
  embeddingRunId: string;
  position: number;
  thickness: number;
  uById: Map<string, number>;
}

export interface SliceMasks {
  /** "only" mode: 1 = inside the layer (hidden otherwise); null when not applicable. */
  mask: Uint8Array | null;
  /** "dim" mode: 1 = outside the layer (drawn faded); null when not applicable. */
  dimMask: Uint8Array | null;
  inLayer: number;
  total: number;
  /** Points without a u value (cloud from another embedding run). */
  unknown: number;
}

/**
 * Build the display masks of one cloud for the active slice.
 * Returns null when the slice does not apply (disabled, display off, or the
 * cloud's projection was built from ANOTHER embedding run — membership of
 * those vectors is undefined and the views must say so instead of guessing).
 */
export function sliceMasksForCloud(
  fragmentIds: ArrayLike<string>,
  source: SliceSource,
  cloudEmbeddingRunId: string,
  display: "off" | "dim" | "only",
): SliceMasks | null {
  if (display === "off") return null;
  if (source.embeddingRunId !== cloudEmbeddingRunId) return null;
  const { mask, inLayer, unknown } = cloudSliceMask(fragmentIds, source.uById, source);
  if (display === "only") {
    return { mask, dimMask: null, inLayer, total: fragmentIds.length, unknown };
  }
  const dimMask = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) dimMask[i] = mask[i] ? 0 : 1;
  return { mask: null, dimMask, inLayer, total: fragmentIds.length, unknown };
}

/**
 * Indices drawn in the BRIGHT buffer of a 3D scene: allowed by `mask`
 * (null = every point) and NOT handed over to the dimmed buffer by
 * `dimMask`. Every point is drawn exactly once — bright or dimmed, never
 * both: overlaying a translucent dim sprite on a full-color point left the
 * point visibly bright and the "dim out-of-layer" mode did nothing.
 */
export function brightIndices(
  count: number,
  mask: Uint8Array | null,
  dimMask: Uint8Array | null,
): Int32Array {
  const list: number[] = [];
  for (let i = 0; i < count; i++) {
    if (mask && !mask[i]) continue;
    if (dimMask && dimMask[i]) continue; // drawn once — in the dimmed buffer
    list.push(i);
  }
  return Int32Array.from(list);
}
