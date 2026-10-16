/**
 * Pure math helpers for the space views (no three.js imports — unit-testable
 * in jsdom). All functions operate on flat Float32Array coordinate buffers.
 *
 * Conventions:
 * - "raw" coordinates are the projection coordinates as computed by the
 *   backend (PC1/UMAP1 units — they belong to the PROJECTION, never to the
 *   original embedding space, TZ §5.2);
 * - "display" coordinates are raw coordinates centered and uniformly scaled
 *   to fit [-1, 1] — a VIEW transform for the 3D scene only (it never feeds
 *   back into any computation);
 * - NDC (normalized device coordinates): x ∈ [-1, 1] → right, y ∈ [-1, 1] → up.
 */

/* ------------------------------------------------------------------ */
/* 3D fit transform                                                    */
/* ------------------------------------------------------------------ */

export interface FitTransform {
  /** Per-axis center of the bounding box (raw units). */
  center: number[];
  /** Half-extent of the largest axis; 1 when degenerate (all points equal). */
  extent: number;
}

/** Compute the uniform fit transform of an N×k cloud (k = 2 or 3). */
export function computeFit(coords: Float32Array, count: number, k: number): FitTransform {
  return computeFitStrided(coords, count, k, k);
}

/**
 * Fit transform over the FIRST `k` components of an interleaved buffer with
 * a larger `stride` (a 4-component cloud is displayed as 3D: the scene fits
 * axes 0..2, the 4th axis belongs to the "time" slider).
 */
export function computeFitStrided(
  coords: Float32Array,
  count: number,
  stride: number,
  k: number,
): FitTransform {
  const min = new Array<number>(k).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(k).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < k; a++) {
      const v = coords[i * stride + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const center = new Array<number>(k);
  let extent = 0;
  for (let a = 0; a < k; a++) {
    if (!Number.isFinite(min[a])) {
      // empty cloud
      center[a] = 0;
      continue;
    }
    center[a] = (min[a] + max[a]) / 2;
    extent = Math.max(extent, (max[a] - min[a]) / 2);
  }
  return { center, extent: extent > 0 ? extent : 1 };
}

/** Apply the fit transform → display coordinates inside [-1, 1]. */
export function applyFit(coords: Float32Array, fit: FitTransform): Float32Array {
  const k = fit.center.length;
  return applyFitStrided(coords, fit, k, k);
}

/** Apply the fit to the first `k` of `stride` components → count×k buffer. */
export function applyFitStrided(
  coords: Float32Array,
  fit: FitTransform,
  stride: number,
  k: number,
): Float32Array {
  const count = stride > 0 ? Math.floor(coords.length / stride) : 0;
  const out = new Float32Array(count * k);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < k; a++) {
      out[i * k + a] = (coords[i * stride + a] - fit.center[a]) / fit.extent;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Rectangles & NDC selection (marquee)                                */
/* ------------------------------------------------------------------ */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * True when the drag rectangle is a real marquee, not a click: guards the
 * selection from degenerate zero-area rects (the regression that used to
 * wipe the selection on a toolbar click in marquee mode).
 */
export function marqueeExceedsSlop(rect: Rect, slopPx: number): boolean {
  return Math.abs(rect.x1 - rect.x0) >= slopPx || Math.abs(rect.y1 - rect.y0) >= slopPx;
}

/** Normalize a drag rectangle so x0<=x1 and y0<=y1 (drag direction-agnostic). */
export function normalizeRect(rect: Rect): Rect {
  return {
    x0: Math.min(rect.x0, rect.x1),
    x1: Math.max(rect.x0, rect.x1),
    y0: Math.min(rect.y0, rect.y1),
    y1: Math.max(rect.y0, rect.y1),
  };
}

/**
 * Indices of points whose NDC position falls inside the (normalized) rect.
 * `ndc` holds interleaved x,y per point in NDC space.
 */
export function indicesInNdcRect(ndc: Float32Array, rect: Rect): number[] {
  const r = normalizeRect(rect);
  const hits: number[] = [];
  for (let i = 0; i < ndc.length; i += 2) {
    const x = ndc[i];
    const y = ndc[i + 1];
    if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
      hits.push(i / 2);
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* 2D plot mapping                                                     */
/* ------------------------------------------------------------------ */

export interface PlotBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Padding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Data bounds of the first two axes with a margin; degenerate (equal min/max)
 *  axes are padded so a single point still maps to the plot center. */
export function computeBounds2D(coords: Float32Array, count: number): PlotBounds {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const x = coords[i * 2];
    const y = coords[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) {
    return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  }
  const padX = (maxX - minX) * 0.06 || 0.5;
  const padY = (maxY - minY) * 0.06 || 0.5;
  return { minX: minX - padX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY };
}

export interface PlotGeometry {
  width: number;
  height: number;
  padding: Padding;
  bounds: PlotBounds;
}

/** Default 2D plot padding (shared with tests). */
export const DEFAULT_PADDING: Padding = { left: 54, right: 14, top: 12, bottom: 30 };

/** Raw data → canvas pixels (y flips: canvas grows down, plots grow up). */
export function dataToCanvas(x: number, y: number, g: PlotGeometry): { cx: number; cy: number } {
  const plotW = Math.max(1, g.width - g.padding.left - g.padding.right);
  const plotH = Math.max(1, g.height - g.padding.top - g.padding.bottom);
  const spanX = g.bounds.maxX - g.bounds.minX || 1;
  const spanY = g.bounds.maxY - g.bounds.minY || 1;
  return {
    cx: g.padding.left + ((x - g.bounds.minX) / spanX) * plotW,
    cy: g.padding.top + (1 - (y - g.bounds.minY) / spanY) * plotH,
  };
}

/** Canvas pixels → raw data (inverse of dataToCanvas; used for hit-testing
 *  pointer positions and marquee corners). */
export function canvasToData(cx: number, cy: number, g: PlotGeometry): { x: number; y: number } {
  const plotW = Math.max(1, g.width - g.padding.left - g.padding.right);
  const plotH = Math.max(1, g.height - g.padding.top - g.padding.bottom);
  const spanX = g.bounds.maxX - g.bounds.minX || 1;
  const spanY = g.bounds.maxY - g.bounds.minY || 1;
  return {
    x: g.bounds.minX + ((cx - g.padding.left) / plotW) * spanX,
    y: g.bounds.minY + (1 - (cy - g.padding.top) / plotH) * spanY,
  };
}

/** Index of the nearest point within `radiusPx` of the target pixel, or null.
 * `pixelOf` maps a point index to canvas pixels (kept injectable for tests). */
export function hitTest2D(
  count: number,
  target: { cx: number; cy: number },
  radiusPx: number,
  pixelOf: (index: number) => { cx: number; cy: number },
): number | null {
  let best: number | null = null;
  let bestDist = radiusPx * radiusPx;
  for (let i = 0; i < count; i++) {
    const { cx, cy } = pixelOf(i);
    const dx = cx - target.cx;
    const dy = cy - target.cy;
    const dist = dx * dx + dy * dy;
    if (dist <= bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Indices of points inside a data-space rectangle (2D marquee). */
export function indicesInDataRect(
  coords: Float32Array,
  count: number,
  rect: { minX: number; maxX: number; minY: number; maxY: number },
): number[] {
  const hits: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = coords[i * 2];
    const y = coords[i * 2 + 1];
    if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) {
      hits.push(i);
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Axis ticks                                                          */
/* ------------------------------------------------------------------ */

/** "Nice" tick values (1/2/5 · 10^k steps) covering [min, max]. */
export function makeTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const rough = (max - min) / Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  let step = pow;
  for (const candidate of [pow, 2 * pow, 5 * pow, 10 * pow]) {
    step = candidate;
    if ((max - min) / candidate <= target) break;
  }
  const ticks: number[] = [];
  const start = Math.ceil(min / step) * step;
  for (let v = start; v <= max + step * 1e-9; v += step) {
    // kill float dust (e.g. 0.30000000000000004)
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks;
}

/** Compact tick label: decimal count derived from the step's own digits
 *  (steps from makeTicks are 1/2/5·10^k → at most 6 decimals), exponential
 *  at the magnitudes where fixed notation stops being readable. */
export function formatTick(value: number, step: number): string {
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-4) return value.toExponential(1);
  const stepText = String(step);
  const dot = stepText.indexOf(".");
  const decimals = dot === -1 ? 0 : Math.min(6, stepText.length - dot - 1);
  return value.toFixed(decimals);
}

/* ------------------------------------------------------------------ */
/* 4D view: the "time" layer along one axis                            */
/* ------------------------------------------------------------------ */

/** Min/max of one component of an interleaved buffer (finite values only). */
export function axisExtent(
  coords: Float32Array,
  count: number,
  stride: number,
  axis: number,
): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const v = coords[i * stride + axis];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0 };
  }
  return { min, max };
}

export interface Layer4D {
  /** 1 = inside the window around `tFrac` on the chosen axis, 0 = outside. */
  mask: Uint8Array;
  inLayer: number;
  /** Window center in RAW axis units (for the numeric readout). */
  t: number;
  /** Full window width in RAW axis units. */
  width: number;
  min: number;
  max: number;
}

/**
 * Points whose `axis` coordinate falls inside [t - w/2, t + w/2]:
 * tFrac/wFrac are 0..1 fractions of the axis range, so the slider state
 * stays meaningful when the projection (and its units) changes.
 * A degenerate (constant) axis puts every point in the layer — honestly,
 * there is nothing to slice.
 */
export function layerMask4D(
  coords: Float32Array,
  count: number,
  stride: number,
  axis: number,
  tFrac: number,
  wFrac: number,
): Layer4D {
  const { min, max } = axisExtent(coords, count, stride, axis);
  const range = max - min;
  const t = min + clamp01(tFrac) * range;
  const width = clamp01(wFrac) * range;
  const half = width / 2;
  const mask = new Uint8Array(count);
  let inLayer = 0;
  for (let i = 0; i < count; i++) {
    const v = coords[i * stride + axis];
    const inside = range === 0 ? true : Math.abs(v - t) <= half;
    mask[i] = inside ? 1 : 0;
    if (inside) inLayer += 1;
  }
  return { mask, inLayer, t, width, min, max };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ------------------------------------------------------------------ */
/* 2D plot zoom & pan (bounds-space camera)                            */
/* ------------------------------------------------------------------ */

/** Zoom limits relative to the auto-fit bounds (span ratio fit/current). */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 50;

/** Current zoom level: 1 = auto-fit, >1 = zoomed in. */
export function zoomLevel(bounds: PlotBounds, fit: PlotBounds): number {
  const fitSpan = fit.maxX - fit.minX || 1;
  const span = bounds.maxX - bounds.minX || Number.NaN;
  if (!Number.isFinite(span) || span === 0) return 1;
  return fitSpan / span;
}

/**
 * Zoom `bounds` by `factor` (>1 = zoom in) keeping the data point under the
 * cursor (`anchor`) fixed; the result is clamped to MIN_ZOOM..MAX_ZOOM
 * relative to the auto-fit bounds so the cloud can never be lost off-screen.
 */
export function zoomBoundsAt(
  bounds: PlotBounds,
  fit: PlotBounds,
  factor: number,
  anchor: { x: number; y: number },
): PlotBounds {
  if (!Number.isFinite(factor) || factor <= 0) return bounds;
  const clampSpan = (span: number, fitSpan: number): number => {
    const base = fitSpan > 0 ? fitSpan : Math.abs(span) || 1;
    return Math.min(base / MIN_ZOOM, Math.max(span / factor, base / MAX_ZOOM));
  };
  const rescale = (min: number, max: number, fitMin: number, fitMax: number, a: number) => {
    const span = max - min;
    const next = clampSpan(span, fitMax - fitMin);
    const r = span > 0 ? next / span : 1;
    const nextMin = a - (a - min) * r;
    return { min: nextMin, max: nextMin + next };
  };
  const x = rescale(bounds.minX, bounds.maxX, fit.minX, fit.maxX, anchor.x);
  const y = rescale(bounds.minY, bounds.maxY, fit.minY, fit.maxY, anchor.y);
  return { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max };
}

/**
 * Pan `bounds` by a pointer drag of (dxPx, dyPx) canvas pixels: the content
 * follows the cursor (drag right → the view shifts left in data space).
 */
export function panBounds(
  bounds: PlotBounds,
  dxPx: number,
  dyPx: number,
  geom: PlotGeometry,
): PlotBounds {
  const plotW = Math.max(1, geom.width - geom.padding.left - geom.padding.right);
  const plotH = Math.max(1, geom.height - geom.padding.top - geom.padding.bottom);
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const dx = (dxPx / plotW) * spanX;
  const dy = (dyPx / plotH) * spanY;
  return {
    minX: bounds.minX - dx,
    maxX: bounds.maxX - dx,
    // canvas y grows down, data y grows up → dragging down shifts minY up
    minY: bounds.minY + dy,
    maxY: bounds.maxY + dy,
  };
}
