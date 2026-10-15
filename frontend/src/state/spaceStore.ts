/**
 * Space view store (stage 3): interface state of the SPACE section.
 *
 * Division of responsibility (TZ §2.2):
 * - projectStore  → shared selection state (active fragment + multi-selection);
 * - experimentStore → experiment configuration (projection form/inventory/job);
 * - spaceStore (this) → loaded point clouds, hover, view settings.
 *
 * Point clouds are built from REAL projection coordinates served by the
 * backend (never synthesized client-side — TZ §17.2). The 3D "display"
 * buffer is a pure view transform (center + uniform scale into [-1,1]);
 * all picking/marquee math that must match the backend coordinates uses
 * the raw buffer.
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type { ProjectionPoint, ProjectionPoints, ProjectionRunDTO } from "../api/types";
import { applyFit, computeFit, type FitTransform } from "../space/selectionMath";
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
  /** Raw projection coordinates, count × n (interleaved). */
  coords: Float32Array;
  /** Raw coords centered+scaled into [-1,1] for the 3D scene (view-only). */
  display: Float32Array;
  fit: FitTransform;
  indexById: Map<string, number>;
}

export interface SpaceError {
  code: string;
  message: string;
  hint?: string;
}

export type CloudKind = "3d" | "2d";
export type InteractionMode = "orbit" | "marquee";
/** Which views the center column shows (top toggle in the SPACE section). */
export type ViewMode = "3d" | "2d" | "split";

interface SpaceState {
  cloud3d: PointCloud | null;
  cloud2d: PointCloud | null;
  loading3d: boolean;
  loading2d: boolean;
  error: SpaceError | null;
  /** Fragment under the cursor (shared by both views for sync highlight). */
  hoveredId: string | null;
  /** Tooltip anchor in container pixels (per view). */
  hoverScreen: { kind: CloudKind; x: number; y: number } | null;
  interactionMode: InteractionMode;
  pointSize: number;
  viewMode: ViewMode;

  setViewMode: (mode: ViewMode) => void;
  setActiveProjection: (
    kind: CloudKind,
    projectionId: string | null,
    opts?: { force?: boolean },
  ) => Promise<void>;
  reloadActive: () => Promise<void>;
  setHover: (id: string | null, screen?: { kind: CloudKind; x: number; y: number }) => void;
  setInteractionMode: (mode: InteractionMode) => void;
  setPointSize: (size: number) => void;
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
  const fit = computeFit(coords, count, n);
  return {
    projection,
    points,
    metas,
    coords,
    display: applyFit(coords, fit),
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
): { three: ProjectionRunDTO | null; two: ProjectionRunDTO | null } {
  const candidates = embeddingRunId
    ? projections.filter((p) => p.embedding_run_id === embeddingRunId && p.cache_ok)
    : [];
  const pick = (n: number): ProjectionRunDTO | null => {
    const fresh = candidates.filter((p) => p.n_components === n && !p.stale);
    const pool = fresh.length > 0 ? fresh : candidates.filter((p) => p.n_components === n);
    // inventory is sorted by updated_at desc; keep that order
    return pool[0] ?? null;
  };
  return { three: pick(3), two: pick(2) };
}

export const useSpaceStore = create<SpaceState>()((set, get) => ({
  cloud3d: null,
  cloud2d: null,
  loading3d: false,
  loading2d: false,
  error: null,
  hoveredId: null,
  hoverScreen: null,
  interactionMode: "orbit",
  pointSize: 4,
  viewMode: "3d",

  setViewMode: (mode) => set({ viewMode: mode }),

  setActiveProjection: async (kind, projectionId, opts) => {
    const project = useProjectStore.getState().current;
    const current = kind === "3d" ? get().cloud3d : get().cloud2d;
    if (!project || projectionId === null) {
      set(
        kind === "3d"
          ? { cloud3d: null, loading3d: false }
          : { cloud2d: null, loading2d: false },
      );
      return;
    }
    if (!opts?.force && current?.projection.id === projectionId) {
      return; // already showing this projection
    }
    set(kind === "3d" ? { loading3d: true, error: null } : { loading2d: true, error: null });
    try {
      // Inventory entry (axis labels etc.) + coordinates in parallel.
      const [projections, points] = await Promise.all([
        api.listProjections(project.id),
        api.getProjectionPoints(project.id, projectionId),
      ]);
      const projection = projections.find((p) => p.id === projectionId);
      if (!projection) {
        // disappeared between calls (deleted project data): treat as error
        throw new ApiError(404, "projection_not_found", "Проекция не найдена в инвентаре.");
      }
      const cloud = buildCloud(points, projection);
      set(
        kind === "3d"
          ? { cloud3d: cloud, loading3d: false, error: null }
          : { cloud2d: cloud, loading2d: false, error: null },
      );
    } catch (err) {
      set(
        kind === "3d"
          ? { loading3d: false, error: toError(err) }
          : { loading2d: false, error: toError(err) },
      );
    }
  },

  reloadActive: async () => {
    // Re-fetch the clouds currently on screen (after a projection job or an
    // embedding recompute the same id may carry fresher data/staleness).
    const { cloud3d, cloud2d } = get();
    const tasks: Promise<void>[] = [];
    if (cloud3d) tasks.push(get().setActiveProjection("3d", cloud3d.projection.id, { force: true }));
    if (cloud2d) tasks.push(get().setActiveProjection("2d", cloud2d.projection.id, { force: true }));
    await Promise.all(tasks);
  },

  setHover: (id, screen) => {
    if (id === get().hoveredId && screen === undefined) return;
    set({ hoveredId: id, hoverScreen: id === null ? null : (screen ?? null) });
  },

  setInteractionMode: (mode) => set({ interactionMode: mode }),
  setPointSize: (size) => set({ pointSize: Math.min(8, Math.max(1, Math.round(size))) }),

  reset: () =>
    set({
      cloud3d: null,
      cloud2d: null,
      loading3d: false,
      loading2d: false,
      error: null,
      hoveredId: null,
      hoverScreen: null,
      interactionMode: "orbit",
    }),
}));
