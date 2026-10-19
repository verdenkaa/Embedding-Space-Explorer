/**
 * Space view store: interface state of the SPACE section.
 *
 * Division of responsibility:
 * - projectStore  → shared selection state (active fragment + multi-selection);
 * - experimentStore → experiment configuration (projection form/inventory/job);
 * - spaceStore (this) → loaded point clouds, hover, view settings.
 *
 * Point clouds are built from REAL projection coordinates served by the
 * backend (never synthesized client-side). The scene "display"
 * buffer is a pure view transform (center + uniform scale into [-1,1]) over
 * the first min(n, 3) components; all picking/marquee math that must match
 * the backend coordinates uses the raw buffer.
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type {
  ProjectionPoint,
  ProjectionPoints,
  ProjectionRunDTO,
  SliceNormalKind,
} from "../api/types";
import {
  applyFitStrided,
  computeFitStrided,
  type FitTransform,
} from "../space/selectionMath";
import { useProjectStore } from "./projectStore";

export interface PointMeta {
  fragmentId: string;
  fileId: string;
  relPath: string;
  kind: string;
  name: string | null;
  symbolPath: string;
  startLine: number;
  endLine: number;
}

export interface PointCloud {
  projection: ProjectionRunDTO;
  points: ProjectionPoints;
  metas: PointMeta[];
  /** Raw projection coordinates, count × n_components (interleaved). */
  coords: Float32Array;
  /** Component count of `coords` per point (2, 3 or 4). */
  stride: number;
  /** Raw coords of the first min(n,3) axes centered+scaled into [-1,1]
   *  (view-only, count × displayStride). */
  display: Float32Array;
  /** Components per point in `display` (always min(n_components, 3)). */
  displayStride: number;
  fit: FitTransform;
  indexById: Map<string, number>;
}

export interface SpaceError {
  code: string;
  message: string;
  hint?: string;
}

export type CloudKind = "3d" | "2d" | "4d";
/** Which views the center column shows (top toggle in the SPACE section). */
export type ViewMode = "3d" | "2d" | "4d" | "split";

/**
 * 4D view: the 4th axis is interpreted as "time" — a window [t ± w/2]
 * travels along it and only the points inside the window are shown.
 * Position/thickness are fractions (0..1) of the axis range so the slider
 * state survives switching between projections with different units.
 */
export interface Slice4D {
  tFrac: number;
  wFrac: number;
  playing: boolean;
}

export const DEFAULT_SLICE_4D: Slice4D = { tFrac: 0.5, wFrac: 0.15, playing: false };

/**
 * Slice of the ORIGINAL space laid over the views.
 * The backend serves u(x) = dot(x - centroid, n) per fragment once per
 * (run, normal); position/thickness sliders re-mask client-side (pure math
 * in space/sliceMath.ts). `display`: off — no overlay; dim — points outside
 * the layer are faded; only — points outside the layer are hidden.
 */
export interface SliceOverlay {
  embeddingRunId: string;
  normalKind: SliceNormalKind;
  normalIndex: number | null;
  position: number;
  thickness: number;
  uMin: number;
  uMax: number;
  total: number;
  uById: Map<string, number>;
  note: string;
  /** Explicit normal vector when the overlay was applied from one (saved
   *  slices); null for axis/pca specs re-resolved by the backend. */
  vector: number[] | null;
  /** Saved-slice row this overlay came from (experiments restore by it);
   *  null for ad-hoc axis/pca specs. */
  savedSliceId: string | null;
}

export type SliceDisplayMode = "off" | "dim" | "only";
export type ColorBy = "kind" | "cluster";

/** What a finished projection job built — used to show the result at once. */
export type PendingBuild =
  | {
      mode: "multi2d";
      sets: number[][];
      embeddingRunId: string;
      seed: number;
      standardize: boolean;
    }
  | { mode: "single"; components: number[]; embeddingRunId: string };

interface SpaceState {
  cloud3d: PointCloud | null;
  /** 2D plots shown side by side (multi axis-set builds); usually 0..1. */
  clouds2d: PointCloud[];
  cloud4d: PointCloud | null;
  loading3d: boolean;
  loading2d: boolean;
  loading4d: boolean;
  error: SpaceError | null;
  /** Fragment under the cursor (shared by all views for sync highlight). */
  hoveredId: string | null;
  /** Tooltip anchor in container pixels (per view). */
  hoverScreen: { kind: CloudKind; x: number; y: number } | null;
  pointSize: number;
  viewMode: ViewMode;
  slice4d: Slice4D;
  /** Slice of the original space overlaid on the views (null = inactive). */
  sliceOverlay: SliceOverlay | null;
  sliceDisplay: SliceDisplayMode;
  /** Point coloring: by fragment kind or by an applied clustering. */
  colorBy: ColorBy;
  clusterLabels: Map<string, number> | null;
  /** Human label of the applied clustering («DBSCAN · исходное · eps 0.5»). */
  clusterCaption: string | null;
  /** Clustering run the applied labels came from (experiment capture). */
  clusterRunId: string | null;
  /** Draw structural relations of the active fragment in the 3D scene. */
  relationLines: boolean;

  setViewMode: (mode: ViewMode) => void;
  setActiveProjection: (
    kind: CloudKind,
    projectionId: string | null,
    opts?: { force?: boolean },
  ) => Promise<void>;
  /** Show several 2D projections side by side (multi axis-set build). */
  setActive2dProjections: (projectionIds: string[], opts?: { force?: boolean }) => Promise<void>;
  reloadActive: () => Promise<void>;
  setHover: (id: string | null, screen?: { kind: CloudKind; x: number; y: number }) => void;
  setPointSize: (size: number) => void;
  setSlice4d: (patch: Partial<Omit<Slice4D, "playing">>) => void;
  setSlicePlaying: (playing: boolean) => void;
  setSliceOverlay: (overlay: SliceOverlay | null) => void;
  patchSliceOverlay: (patch: Partial<Pick<SliceOverlay, "position" | "thickness">>) => void;
  setSliceDisplay: (mode: SliceDisplayMode) => void;
  setColorBy: (colorBy: ColorBy) => void;
  setClusterLabels: (
    labels: Map<string, number> | null,
    caption: string | null,
    runId?: string | null,
  ) => void;
  setRelationLines: (enabled: boolean) => void;
  /** Point the views at what a finished build produced (and show it). */
  applyBuiltProjections: (projections: ProjectionRunDTO[], pending: PendingBuild) => void;
  reset: () => void;
}

function toError(err: unknown): SpaceError {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  return { code: "unknown_error", message: err instanceof Error ? err.message : String(err) };
}

/** Build the render-ready cloud from the served DTO (pure, unit-tested). */
export function buildCloud(points: ProjectionPoints, projection: ProjectionRunDTO): PointCloud {
  const n = points.n_components;
  const count = points.points.length;
  const coords = new Float32Array(count * n);
  const metas: PointMeta[] = new Array(count);
  const indexById = new Map<string, number>();
  points.points.forEach((point: ProjectionPoint, i: number) => {
    for (let a = 0; a < n; a++) {
      coords[i * n + a] = point.coords[a] ?? 0;
    }
    metas[i] = {
      fragmentId: point.fragment_id,
      fileId: point.file_id,
      relPath: point.rel_path,
      kind: point.kind,
      name: point.name,
      symbolPath: point.symbol_path,
      startLine: point.start_line,
      endLine: point.end_line,
    };
    indexById.set(point.fragment_id, i);
  });
  // The scene shows at most 3 axes; a 4-component cloud keeps its 4th axis
  // in `coords` for the "time" slider (honest: nothing is dropped silently).
  const displayStride = Math.min(n, 3);
  const fit = computeFitStrided(coords, count, n, displayStride);
  return {
    projection,
    points,
    metas,
    coords,
    stride: n,
    display: applyFitStrided(coords, fit, n, displayStride),
    displayStride,
    fit,
    indexById,
  };
}

/**
 * Choose which cached projections the views should show for an embedding
 * run: freshest non-stale per component count; stale ones are picked as a
 * fallback so the user sees SOMETHING with an honest "устарела" badge.
 * Pure — unit-tested.
 */
export function pickActiveProjections(
  projections: ProjectionRunDTO[],
  embeddingRunId: string | null,
): {
  three: ProjectionRunDTO | null;
  two: ProjectionRunDTO | null;
  four: ProjectionRunDTO | null;
} {
  const candidates = embeddingRunId
    ? projections.filter((p) => p.embedding_run_id === embeddingRunId && p.cache_ok)
    : [];
  const pick = (n: number): ProjectionRunDTO | null => {
    const fresh = candidates.filter((p) => p.n_components === n && !p.stale);
    const pool = fresh.length > 0 ? fresh : candidates.filter((p) => p.n_components === n);
    // inventory is sorted by updated_at desc; keep that order
    return pool[0] ?? null;
  };
  return { three: pick(3), two: pick(2), four: pick(4) };
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

async function fetchCloud(projectId: string, projectionId: string): Promise<PointCloud> {
  // Inventory entry (axis labels etc.) + coordinates in parallel.
  const [projections, points] = await Promise.all([
    api.listProjections(projectId),
    api.getProjectionPoints(projectId, projectionId),
  ]);
  const projection = projections.find((p) => p.id === projectionId);
  if (!projection) {
    // disappeared between calls (deleted elsewhere): treat as error
    throw new ApiError(404, "projection_not_found", "Проекция не найдена в инвентаре.");
  }
  return buildCloud(points, projection);
}

const KIND_STATE = {
  "3d": { cloud: "cloud3d", loading: "loading3d" },
  "2d": { cloud: "clouds2d", loading: "loading2d" },
  "4d": { cloud: "cloud4d", loading: "loading4d" },
} as const;

export const useSpaceStore = create<SpaceState>()((set, get) => ({
  cloud3d: null,
  clouds2d: [],
  cloud4d: null,
  loading3d: false,
  loading2d: false,
  loading4d: false,
  error: null,
  hoveredId: null,
  hoverScreen: null,
  pointSize: 4,
  viewMode: "3d",
  slice4d: { ...DEFAULT_SLICE_4D },
  sliceOverlay: null,
  sliceDisplay: "dim",
  colorBy: "kind",
  clusterLabels: null,
  clusterCaption: null,
  clusterRunId: null,
  relationLines: false,

  setViewMode: (mode) => set({ viewMode: mode }),

  setActiveProjection: async (kind, projectionId, opts) => {
    const project = useProjectStore.getState().current;
    const s = get();
    const currentIds =
      kind === "3d"
        ? s.cloud3d
          ? [s.cloud3d.projection.id]
          : []
        : kind === "2d"
          ? s.clouds2d.map((c) => c.projection.id)
          : s.cloud4d
            ? [s.cloud4d.projection.id]
            : [];
    const nextIds = projectionId === null ? [] : [projectionId];
    if (!project || projectionId === null) {
      set(clearKind(kind));
      return;
    }
    if (!opts?.force && sameIds(currentIds, nextIds)) {
      return; // already showing this projection
    }
    set({ [KIND_STATE[kind].loading]: true, error: null } as Partial<SpaceState>);
    try {
      const cloud = await fetchCloud(project.id, projectionId);
      set(
        kind === "2d"
          ? { clouds2d: [cloud], loading2d: false, error: null }
          : kind === "3d"
            ? { cloud3d: cloud, loading3d: false, error: null }
            : { cloud4d: cloud, loading4d: false, error: null },
      );
    } catch (err) {
      set({ [KIND_STATE[kind].loading]: false, error: toError(err) } as Partial<SpaceState>);
    }
  },

  setActive2dProjections: async (projectionIds, opts) => {
    const project = useProjectStore.getState().current;
    const ids = [...new Set(projectionIds)];
    if (!project || ids.length === 0) {
      set({ clouds2d: [], loading2d: false });
      return;
    }
    if (!opts?.force && sameIds(get().clouds2d.map((c) => c.projection.id), ids)) {
      return; // already showing exactly these plots
    }
    set({ loading2d: true, error: null });
    try {
      const projections = await api.listProjections(project.id);
      const clouds: PointCloud[] = [];
      for (const id of ids) {
        const projection = projections.find((p) => p.id === id);
        if (!projection) {
          throw new ApiError(404, "projection_not_found", "Проекция не найдена в инвентаре.");
        }
        const points = await api.getProjectionPoints(project.id, id);
        clouds.push(buildCloud(points, projection));
      }
      set({ clouds2d: clouds, loading2d: false, error: null });
    } catch (err) {
      set({ loading2d: false, error: toError(err) });
    }
  },

  reloadActive: async () => {
    // Re-fetch the clouds currently on screen (after a projection job or an
    // embedding recompute the same id may carry fresher data/staleness).
    const { cloud3d, clouds2d, cloud4d } = get();
    const tasks: Promise<void>[] = [];
    if (cloud3d) {
      tasks.push(get().setActiveProjection("3d", cloud3d.projection.id, { force: true }));
    }
    if (clouds2d.length > 0) {
      tasks.push(
        get().setActive2dProjections(
          clouds2d.map((c) => c.projection.id),
          { force: true },
        ),
      );
    }
    if (cloud4d) {
      tasks.push(get().setActiveProjection("4d", cloud4d.projection.id, { force: true }));
    }
    await Promise.all(tasks);
  },

  setHover: (id, screen) => {
    if (id === get().hoveredId && screen === undefined) return;
    set({ hoveredId: id, hoverScreen: id === null ? null : (screen ?? null) });
  },

  setPointSize: (size) => set({ pointSize: Math.min(8, Math.max(1, Math.round(size))) }),

  setSlice4d: (patch) => set({ slice4d: { ...get().slice4d, ...patch } }),
  setSlicePlaying: (playing) => set({ slice4d: { ...get().slice4d, playing } }),

  setSliceOverlay: (overlay) => set({ sliceOverlay: overlay }),
  patchSliceOverlay: (patch) => {
    const current = get().sliceOverlay;
    if (!current) return;
    set({ sliceOverlay: { ...current, ...patch } });
  },
  setSliceDisplay: (mode) => set({ sliceDisplay: mode }),
  setColorBy: (colorBy) => set({ colorBy }),
  setClusterLabels: (labels, caption, runId = null) =>
    set({
      clusterLabels: labels,
      clusterCaption: caption,
      clusterRunId: labels ? runId : null,
      colorBy: labels ? "cluster" : "kind",
    }),
  setRelationLines: (enabled) => set({ relationLines: enabled }),

  applyBuiltProjections: (projections, pending) => {
    if (pending.mode === "multi2d") {
      const ids: string[] = [];
      for (const axisPair of pending.sets) {
        const run = projections.find(
          (p) =>
            p.method === "raw_axes" &&
            p.n_components === 2 &&
            p.cache_ok &&
            p.embedding_run_id === pending.embeddingRunId &&
            p.seed === pending.seed &&
            Boolean(p.params["standardize"]) === pending.standardize &&
            Array.isArray(p.params["axes"]) &&
            (p.params["axes"] as number[]).length === 2 &&
            (p.params["axes"] as number[])[0] === axisPair[0] &&
            (p.params["axes"] as number[])[1] === axisPair[1],
        );
        if (run) ids.push(run.id);
      }
      if (ids.length > 0) {
        void get().setActive2dProjections(ids);
        const mode = get().viewMode;
        if (mode === "3d" || mode === "4d") set({ viewMode: "2d" });
      }
      return;
    }

    // single build: show the freshest run per built component count
    // (inventory is sorted by updated_at desc → first match is the new one).
    // The run metadata is already known here — only the coordinates are
    // fetched (no redundant inventory round-trip).
    const project = useProjectStore.getState().current;
    const built = pending.components;
    for (const n of built) {
      const run = projections.find(
        (p) => p.n_components === n && p.cache_ok && p.embedding_run_id === pending.embeddingRunId,
      );
      if (!run || !project) continue;
      const kind: CloudKind = n === 3 ? "3d" : n === 2 ? "2d" : "4d";
      void (async () => {
        set({ [KIND_STATE[kind].loading]: true, error: null } as Partial<SpaceState>);
        try {
          const points = await api.getProjectionPoints(project.id, run.id);
          const cloud = buildCloud(points, run);
          set(
            kind === "2d"
              ? { clouds2d: [cloud], loading2d: false, error: null }
              : kind === "3d"
                ? { cloud3d: cloud, loading3d: false, error: null }
                : { cloud4d: cloud, loading4d: false, error: null },
          );
        } catch (err) {
          set({ [KIND_STATE[kind].loading]: false, error: toError(err) } as Partial<SpaceState>);
        }
      })();
    }
    // make sure the result is actually on screen
    const mode = get().viewMode;
    const shows = (n: number): boolean =>
      mode === "split" ? n === 3 || n === 2 : mode === (n === 3 ? "3d" : n === 2 ? "2d" : "4d");
    if (built.some((n) => !shows(n))) {
      if (built.includes(4)) set({ viewMode: "4d" });
      else if (built.includes(3) && built.includes(2)) set({ viewMode: "split" });
      else if (built.includes(3)) set({ viewMode: "3d" });
      else set({ viewMode: "2d" });
    }
  },

  reset: () =>
    set({
      cloud3d: null,
      clouds2d: [],
      cloud4d: null,
      loading3d: false,
      loading2d: false,
      loading4d: false,
      error: null,
      hoveredId: null,
      hoverScreen: null,
      slice4d: { ...DEFAULT_SLICE_4D },
      sliceOverlay: null,
      sliceDisplay: "dim",
      colorBy: "kind",
      clusterLabels: null,
      clusterCaption: null,
      clusterRunId: null,
      relationLines: false,
    }),
}));

function clearKind(kind: CloudKind): Partial<SpaceState> {
  return kind === "3d"
    ? { cloud3d: null, loading3d: false }
    : kind === "2d"
      ? { clouds2d: [], loading2d: false }
      : { cloud4d: null, loading4d: false };
}
