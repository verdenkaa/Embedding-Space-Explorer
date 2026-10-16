/**
 * Analysis store (stage 4): semantic neighbors, structural relations,
 * automatic clustering, manual groups, slice loading and the background
 * jobs of this section (relations extraction, clustering).
 *
 * Division of responsibility:
 * - projectStore  → selection/active fragment (shared sync state);
 * - experimentStore → embeddings/projections configuration & inventory;
 * - spaceStore    → view state (slice overlay, cluster colors, relation
 *                   lines) — this store FETCHES, spaceStore DISPLAYS;
 * - analysisStore (this) → stage-4 data + its job channel.
 *
 * Honesty rules encoded here: neighbors are requested from the ORIGINAL
 * embeddings endpoint only; relation provenance is preserved as served;
 * clustering labels are applied to the scene explicitly (user action).
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type {
  ClusteringRunDTO,
  ComputeClusteringRequest,
  CreateRelationRequest,
  FragmentGroupDTO,
  ImportRelationsResponse,
  JobInfo,
  NeighborMetric,
  NeighborsResponse,
  RelationsResponse,
  SavedSliceDTO,
  SliceNormalKind,
} from "../api/types";
import { useProjectStore } from "./projectStore";
import { useSpaceStore } from "./spaceStore";

export interface AnalysisError {
  code: string;
  message: string;
  hint?: string;
}

function toError(err: unknown): AnalysisError {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  return { code: "unknown_error", message: err instanceof Error ? err.message : String(err) };
}

export interface BrowserFilters {
  kind: string;
  origin: string;
  offset: number;
}

const PAGE = 100;

interface AnalysisState {
  /* semantic neighbors of the active fragment */
  neighbors: NeighborsResponse | null;
  neighborsFor: string | null;
  neighborsLoading: boolean;

  /* relations of the active fragment (left panel + 3D scene lines) */
  fragmentRelations: RelationsResponse | null;
  fragmentRelationsFor: string | null;
  relationsLoading: boolean;

  /* relations browser (RELATIONS section) */
  browser: RelationsResponse | null;
  browserLoading: boolean;
  browserFilters: BrowserFilters;
  lastImportReport: ImportRelationsResponse | null;

  /* clustering + groups */
  clusteringRuns: ClusteringRunDTO[] | null;
  groups: FragmentGroupDTO[] | null;

  /* slices (saved definitions; the live overlay lives in spaceStore) */
  savedSlices: SavedSliceDTO[] | null;
  sliceLoading: boolean;

  /* stage-4 background jobs (relations extraction, clustering) */
  activeJob: JobInfo | null;
  error: AnalysisError | null;

  loadNeighbors: (fragmentId: string, k: number, metric: NeighborMetric) => Promise<void>;
  loadFragmentRelations: (fragmentId: string) => Promise<void>;
  setBrowserFilters: (patch: Partial<BrowserFilters>) => void;
  loadBrowser: () => Promise<void>;
  extractRelations: () => Promise<void>;
  importRelations: (payload: unknown) => Promise<ImportRelationsResponse | null>;
  createRelation: (payload: CreateRelationRequest) => Promise<boolean>;
  deleteRelation: (id: string) => Promise<void>;

  loadClustering: () => Promise<void>;
  startClustering: (payload: ComputeClusteringRequest) => Promise<void>;
  deleteClustering: (id: string) => Promise<void>;
  showClusteringOnScene: (id: string) => Promise<void>;
  clearClusteringColors: () => void;

  loadGroups: () => Promise<void>;
  createGroup: (name: string, fragmentIds: string[]) => Promise<boolean>;
  deleteGroup: (id: string) => Promise<void>;

  loadSavedSlices: () => Promise<void>;
  computeSlice: (
    embeddingRunId: string,
    kind: SliceNormalKind,
    index: number | null,
    vector?: number[] | null,
    position?: number,
    thickness?: number,
  ) => Promise<void>;
  saveSlice: (name: string) => Promise<void>;
  deleteSavedSlice: (id: string) => Promise<void>;
  applySavedSlice: (id: string) => Promise<void>;

  tickActiveJob: () => Promise<void>;
  cancelActiveJob: () => Promise<void>;
  reset: () => void;
}

export const useAnalysisStore = create<AnalysisState>()((set, get) => ({
  neighbors: null,
  neighborsFor: null,
  neighborsLoading: false,
  fragmentRelations: null,
  fragmentRelationsFor: null,
  relationsLoading: false,
  browser: null,
  browserLoading: false,
  browserFilters: { kind: "", origin: "", offset: 0 },
  lastImportReport: null,
  clusteringRuns: null,
  groups: null,
  savedSlices: null,
  sliceLoading: false,
  activeJob: null,
  error: null,

  loadNeighbors: async (fragmentId, k, metric) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ neighborsLoading: true, error: null });
    try {
      const neighbors = await api.findNeighbors(project.id, fragmentId, k, metric);
      set({ neighbors, neighborsFor: fragmentId, neighborsLoading: false });
    } catch (err) {
      set({ neighbors: null, neighborsFor: fragmentId, neighborsLoading: false, error: toError(err) });
    }
  },

  loadFragmentRelations: async (fragmentId) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ relationsLoading: true });
    try {
      const fragmentRelations = await api.listRelations(project.id, {
        fragment_id: fragmentId,
        limit: 200,
      });
      set({ fragmentRelations, fragmentRelationsFor: fragmentId, relationsLoading: false });
    } catch (err) {
      set({ fragmentRelations: null, relationsLoading: false, error: toError(err) });
    }
  },

  setBrowserFilters: (patch) => {
    set({ browserFilters: { ...get().browserFilters, ...patch } });
    void get().loadBrowser();
  },

  loadBrowser: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    const { kind, origin, offset } = get().browserFilters;
    set({ browserLoading: true });
    try {
      const browser = await api.listRelations(project.id, {
        kind: kind || undefined,
        origin: origin || undefined,
        limit: PAGE,
        offset,
      });
      set({ browser, browserLoading: false, error: null });
    } catch (err) {
      set({ browserLoading: false, error: toError(err) });
    }
  },

  extractRelations: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ error: null });
    try {
      const activeJob = await api.extractRelations(project.id);
      set({ activeJob });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  importRelations: async (payload) => {
    const project = useProjectStore.getState().current;
    if (!project) return null;
    set({ error: null });
    try {
      const report = await api.importRelations(project.id, payload);
      set({ lastImportReport: report });
      await get().loadBrowser();
      return report;
    } catch (err) {
      set({ error: toError(err) });
      return null;
    }
  },

  createRelation: async (payload) => {
    const project = useProjectStore.getState().current;
    if (!project) return false;
    set({ error: null });
    try {
      await api.createRelation(project.id, payload);
      await get().loadBrowser();
      const forId = get().fragmentRelationsFor;
      if (
        forId &&
        (forId === payload.source_fragment_id || forId === payload.target_fragment_id)
      ) {
        await get().loadFragmentRelations(forId);
      }
      return true;
    } catch (err) {
      set({ error: toError(err) });
      return false;
    }
  },

  deleteRelation: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      await api.deleteRelation(project.id, id);
      if (get().browser) await get().loadBrowser();
      const forId = get().fragmentRelationsFor;
      if (forId) await get().loadFragmentRelations(forId);
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  loadClustering: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      const clusteringRuns = await api.listClustering(project.id);
      set({ clusteringRuns, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  startClustering: async (payload) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ error: null });
    try {
      const activeJob = await api.computeClustering(project.id, payload);
      set({ activeJob });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  deleteClustering: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      await api.deleteClustering(project.id, id);
      const space = useSpaceStore.getState();
      if (space.colorBy === "cluster") {
        space.setClusterLabels(null, null);
      }
      await get().loadClustering();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  showClusteringOnScene: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ error: null });
    try {
      const labels = await api.getClusteringLabels(project.id, id);
      const map = new Map<string, number>();
      labels.ids.forEach((fragmentId, i) => map.set(fragmentId, labels.labels[i]));
      const run = get().clusteringRuns?.find((r) => r.id === id);
      const space = labels.space === "projection" ? "проекция" : "исходные векторы";
      const caption = `${labels.algorithm.toUpperCase()} · ${space} · ${labels.metric} · кластеров: ${labels.n_clusters}, шум: ${labels.noise}${run?.stale ? " · УСТАРЕЛА" : ""}`;
      useSpaceStore.getState().setClusterLabels(map, caption);
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  clearClusteringColors: () => {
    useSpaceStore.getState().setClusterLabels(null, null);
  },

  loadGroups: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      const groups = await api.listGroups(project.id);
      set({ groups, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  createGroup: async (name, fragmentIds) => {
    const project = useProjectStore.getState().current;
    if (!project) return false;
    set({ error: null });
    try {
      await api.createGroup(project.id, { name, fragment_ids: fragmentIds });
      await get().loadGroups();
      return true;
    } catch (err) {
      set({ error: toError(err) });
      return false;
    }
  },

  deleteGroup: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      await api.deleteGroup(project.id, id);
      await get().loadGroups();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  loadSavedSlices: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      const savedSlices = await api.listSlices(project.id);
      set({ savedSlices, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  computeSlice: async (embeddingRunId, kind, index, vector, position, thickness) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ sliceLoading: true, error: null });
    try {
      const body = await api.computeSlice(project.id, {
        embedding_run_id: embeddingRunId,
        normal: { kind, index: kind === "vector" ? null : index, vector: vector ?? null },
        // the server needs numbers; defaults are derived client-side from the
        // served range (the u array is here anyway — no second round-trip)
        position: position ?? 0,
        thickness: thickness ?? 0,
      });
      const pos = position ?? (body.u_min + body.u_max) / 2;
      const thick = thickness ?? Math.max((body.u_max - body.u_min) * 0.1, 1e-9);
      const uById = new Map<string, number>();
      body.ids.forEach((id, i) => uById.set(id, body.u[i]));
      useSpaceStore.getState().setSliceOverlay({
        embeddingRunId,
        normalKind: body.normal_kind,
        normalIndex: body.normal_index,
        position: pos,
        thickness: thick,
        uMin: body.u_min,
        uMax: body.u_max,
        total: body.total,
        uById,
        note: body.note,
        vector: vector ?? null,
      });
      set({ sliceLoading: false });
    } catch (err) {
      set({ sliceLoading: false, error: toError(err) });
    }
  },

  saveSlice: async (name) => {
    const project = useProjectStore.getState().current;
    const overlay = useSpaceStore.getState().sliceOverlay;
    if (!project || !overlay || !name.trim()) return;
    set({ error: null });
    try {
      // the backend re-resolves and stores the EXACT unit normal (reproducible)
      await api.saveSlice(project.id, {
        name: name.trim(),
        embedding_run_id: overlay.embeddingRunId,
        normal:
          overlay.normalKind === "vector" && overlay.vector
            ? { kind: "vector", vector: overlay.vector }
            : { kind: overlay.normalKind, index: overlay.normalIndex },
        position: overlay.position,
        thickness: overlay.thickness,
      });
      await get().loadSavedSlices();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  deleteSavedSlice: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      await api.deleteSlice(project.id, id);
      await get().loadSavedSlices();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  applySavedSlice: async (id) => {
    const saved = get().savedSlices?.find((s) => s.id === id);
    if (!saved) return;
    // apply the RESOLVED vector (reproducibility) with saved position/thickness
    await get().computeSlice(
      saved.embedding_run_id,
      "vector",
      null,
      saved.vector,
      saved.position,
      saved.thickness,
    );
    const overlay = useSpaceStore.getState().sliceOverlay;
    if (overlay) {
      // keep the human-readable intent for the panel
      useSpaceStore.getState().setSliceOverlay({
        ...overlay,
        normalKind: saved.normal_kind,
        normalIndex: saved.normal_index,
      });
    }
  },

  tickActiveJob: async () => {
    const project = useProjectStore.getState().current;
    const { activeJob } = get();
    if (!project || !activeJob) return;
    if (activeJob.state !== "queued" && activeJob.state !== "running") return;
    try {
      const job = await api.getJob(project.id, activeJob.id);
      set({ activeJob: job });
      if (job.state === "done" || job.state === "failed" || job.state === "cancelled") {
        if (job.state === "done") {
          if (job.kind === "relations") {
            const tasks: Promise<void>[] = [get().loadBrowser()];
            const forId = get().fragmentRelationsFor;
            if (forId) tasks.push(get().loadFragmentRelations(forId));
            await Promise.all(tasks);
          } else if (job.kind === "clustering") {
            await get().loadClustering();
          }
        }
      }
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  cancelActiveJob: async () => {
    const project = useProjectStore.getState().current;
    const { activeJob } = get();
    if (!project || !activeJob) return;
    try {
      const job = await api.cancelJob(project.id, activeJob.id);
      set({ activeJob: job });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  reset: () =>
    set({
      neighbors: null,
      neighborsFor: null,
      neighborsLoading: false,
      fragmentRelations: null,
      fragmentRelationsFor: null,
      relationsLoading: false,
      browser: null,
      browserFilters: { kind: "", origin: "", offset: 0 },
      lastImportReport: null,
      clusteringRuns: null,
      groups: null,
      savedSlices: null,
      activeJob: null,
      error: null,
    }),
}));
