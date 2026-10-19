/**
 * Saved experiments: capture the current SPACE state,
 * persist it as a named reopenable snapshot, and restore it later — with an
 * HONEST report of what could not be restored (deleted/stale references are
 * listed, never silently substituted).
 *
 * The store reads the other stores one-way (space/analysis/project) and
 * applies restored state through their public actions.
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type {
  ExperimentConfigDTO,
  ExperimentDTO,
  ExperimentSummaryDTO,
} from "../api/types";
import { useAnalysisStore } from "./analysisStore";
import { useProjectStore } from "./projectStore";
import { useSpaceStore } from "./spaceStore";

/** Hard cap matching the backend (an experiment is a config, not a dump). */
export const SELECTION_CAP = 5000;

export interface OpenReport {
  applied: string[];
  skipped: string[];
}

export interface SavedExperimentsError {
  code: string;
  message: string;
  hint?: string;
}

function toError(err: unknown): SavedExperimentsError {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  return { code: "unknown_error", message: err instanceof Error ? err.message : String(err) };
}

interface SavedExperimentsState {
  experiments: ExperimentSummaryDTO[] | null;
  loading: boolean;
  error: SavedExperimentsError | null;
  /** Report of the last «Открыть» action (shown until dismissed). */
  lastOpenReport: OpenReport | null;

  loadExperiments: () => Promise<void>;
  /** Pure read of the live stores → the config the backend validates. */
  captureSpaceState: () => ExperimentConfigDTO;
  saveExperiment: (name: string, description: string) => Promise<boolean>;
  fetchDetail: (id: string) => Promise<ExperimentDTO | null>;
  openExperiment: (id: string) => Promise<OpenReport | null>;
  deleteExperiment: (id: string) => Promise<void>;
  clearOpenReport: () => void;
}

export const useSavedExperimentsStore = create<SavedExperimentsState>()((set, get) => ({
  experiments: null,
  loading: false,
  error: null,
  lastOpenReport: null,

  loadExperiments: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      const experiments = await api.listExperiments(project.id);
      set({ experiments, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  captureSpaceState: () => {
    const space = useSpaceStore.getState();
    const analysis = useAnalysisStore.getState();
    const project = useProjectStore.getState();
    const anyCloud = space.cloud3d ?? space.clouds2d[0] ?? space.cloud4d;
    const overlay = space.sliceOverlay;
    const embeddingRunId =
      anyCloud?.projection.embedding_run_id ?? overlay?.embeddingRunId ?? null;

    const slice: ExperimentConfigDTO["slice"] = overlay
      ? overlay.savedSliceId
        ? {
            saved_slice_id: overlay.savedSliceId,
            position: overlay.position,
            thickness: overlay.thickness,
          }
        : {
            embedding_run_id: overlay.embeddingRunId,
            normal_kind: overlay.normalKind,
            normal_index: overlay.normalIndex,
            normal_vector: overlay.vector,
            position: overlay.position,
            thickness: overlay.thickness,
          }
      : null;

    const selection = project.selectedFragmentIds;
    return {
      view_mode: space.viewMode,
      embedding_run_id: embeddingRunId,
      projections: {
        three: space.cloud3d?.projection.id ?? null,
        two: space.clouds2d.map((c) => c.projection.id),
        four: space.cloud4d?.projection.id ?? null,
      },
      slice,
      slice_display: space.sliceDisplay,
      clustering_run_id: space.clusterRunId,
      color_by: space.colorBy === "cluster" && !space.clusterRunId ? "kind" : space.colorBy,
      group_ids: (analysis.groups ?? []).map((g) => g.id),
      selection: selection.slice(0, SELECTION_CAP),
      selection_truncated: selection.length > SELECTION_CAP,
      metric_run_ids: (analysis.metricRuns ?? []).map((m) => m.id),
    };
  },

  saveExperiment: async (name, description) => {
    const project = useProjectStore.getState().current;
    if (!project || !name.trim()) return false;
    set({ error: null });
    try {
      const config = get().captureSpaceState();
      await api.saveExperiment(project.id, {
        name: name.trim(),
        description: description.trim() || null,
        config,
      });
      await get().loadExperiments();
      return true;
    } catch (err) {
      set({ error: toError(err) });
      return false;
    }
  },

  fetchDetail: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return null;
    try {
      return await api.getExperiment(project.id, id);
    } catch (err) {
      set({ error: toError(err) });
      return null;
    }
  },

  openExperiment: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return null;
    set({ loading: true, error: null, lastOpenReport: null });
    try {
      const exp = await api.getExperiment(project.id, id);
      const report = await applyExperiment(exp);
      set({ loading: false, lastOpenReport: report });
      return report;
    } catch (err) {
      set({ loading: false, error: toError(err) });
      return null;
    }
  },

  deleteExperiment: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      await api.deleteExperiment(project.id, id);
      await get().loadExperiments();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  clearOpenReport: () => set({ lastOpenReport: null }),
}));

/**
 * Apply a fetched experiment to the live stores; returns what was applied
 * and what was honestly skipped (missing references). Exported for tests.
 */
export async function applyExperiment(exp: ExperimentDTO): Promise<OpenReport> {
  const cfg = exp.config;
  const missing = exp.live_status?.missing ?? {};
  const missingSet = new Set(Object.values(missing).flat());
  const applied: string[] = [];
  const skipped: string[] = [];
  const space = useSpaceStore.getState();
  const analysis = useAnalysisStore.getState();

  /* projections of the three views — alive references only */
  const three = cfg.projections.three;
  if (three) {
    if (missingSet.has(three)) {
      skipped.push(`3D-проекция ${three} удалена`);
    } else {
      await space.setActiveProjection("3d", three, { force: true });
      applied.push("3D-вид");
    }
  }
  const twoAll = cfg.projections.two ?? [];
  const twoAlive = twoAll.filter((p) => !missingSet.has(p));
  if (twoAll.length > 0) {
    if (twoAlive.length === 0) {
      skipped.push(`2D-проекции (${twoAll.length}) удалены`);
    } else {
      await space.setActive2dProjections(twoAlive, { force: true });
      applied.push(twoAlive.length > 1 ? `2D-виды (${twoAlive.length})` : "2D-вид");
      if (twoAlive.length < twoAll.length) {
        skipped.push(`часть 2D-проекций удалена (${twoAll.length - twoAlive.length})`);
      }
    }
  }
  const four = cfg.projections.four;
  if (four) {
    if (missingSet.has(four)) {
      skipped.push(`4D-проекция ${four} удалена`);
    } else {
      await space.setActiveProjection("4d", four, { force: true });
      applied.push("4D-вид");
    }
  }
  space.setViewMode(cfg.view_mode);

  /* slice: by saved id (resolved vector) or by inline definition */
  const slice = cfg.slice;
  if (slice) {
    const savedId = slice.saved_slice_id;
    if (savedId) {
      if (missingSet.has(savedId)) {
        skipped.push("сохранённый срез удалён");
      } else {
        await analysis.loadSavedSlices();
        await useAnalysisStore.getState().applySavedSlice(savedId);
        if (typeof slice.position === "number" && typeof slice.thickness === "number") {
          useSpaceStore.getState().patchSliceOverlay({
            position: slice.position,
            thickness: slice.thickness,
          });
        }
        applied.push("срез");
      }
    } else if (slice.embedding_run_id && slice.normal_kind) {
      if (missingSet.has(slice.embedding_run_id)) {
        skipped.push("запуск эмбеддингов среза удалён");
      } else {
        await analysis.computeSlice(
          slice.embedding_run_id,
          slice.normal_kind,
          slice.normal_index ?? null,
          slice.normal_vector ?? undefined,
          slice.position ?? undefined,
          slice.thickness ?? undefined,
        );
        applied.push("срез");
      }
    }
  } else {
    space.setSliceOverlay(null);
  }
  space.setSliceDisplay(cfg.slice_display);

  /* clustering colors */
  const clusteringAlive =
    cfg.clustering_run_id !== null && !missingSet.has(cfg.clustering_run_id ?? "");
  if (cfg.clustering_run_id) {
    if (!clusteringAlive) {
      skipped.push("кластеризация удалена");
      space.setClusterLabels(null, null);
    } else {
      await analysis.loadClustering();
      await useAnalysisStore.getState().showClusteringOnScene(cfg.clustering_run_id);
      applied.push("раскраска кластерами");
    }
  } else {
    space.setClusterLabels(null, null);
  }
  space.setColorBy(
    cfg.color_by === "cluster" ? (clusteringAlive ? "cluster" : "kind") : cfg.color_by,
  );

  /* groups + selection + metrics inventory */
  const missingGroups = missing["group_ids"] ?? [];
  if (missingGroups.length > 0) {
    skipped.push(`группы удалены (${missingGroups.length})`);
  }
  if ((cfg.group_ids ?? []).length > 0) {
    await analysis.loadGroups();
    applied.push(`группы (${cfg.group_ids.length})`);
  }
  if (cfg.selection.length > 0) {
    useProjectStore.getState().setSelectedFragments(cfg.selection);
    applied.push(`выделение (${cfg.selection.length})`);
    if (cfg.selection_truncated) {
      skipped.push("выделение было усечено при сохранении (первые 5000)");
    }
  }
  const missingMetrics = missing["metric_run_ids"] ?? [];
  if (missingMetrics.length > 0) {
    skipped.push(`метрики удалены (${missingMetrics.length})`);
  }
  void analysis.loadMetricRuns();

  return { applied, skipped };
}
