/**
 * Experiment store: embedding models & runs + projection catalog,
 * form, inventory and compute job. Depends on projectStore one-way
 * (reads the current project id); later stages add slices/clustering/metrics
 *.
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type {
  EmbeddingRunDTO,
  JobInfo,
  ModelInfo,
  PrepMode,
  PreparationPreviews,
  ProjectionMethodInfo,
  ProjectionParamValue,
  ProjectionPresetDTO,
  ProjectionRunDTO,
} from "../api/types";
import { useProjectStore } from "./projectStore";
import { useSpaceStore, type PendingBuild } from "./spaceStore";

export interface ExperimentError {
  code: string;
  message: string;
  hint?: string;
}

export type ProjectionParamValues = Record<string, ProjectionParamValue>;

interface ExperimentState {
  models: ModelInfo[] | null;
  previews: PreparationPreviews | null;
  runs: EmbeddingRunDTO[] | null;
  activeJob: JobInfo | null;
  /* embeddings compute form */
  modelId: string | null;
  mode: PrepMode;
  batchSize: number;
  /* projections */
  projectionMethods: ProjectionMethodInfo[] | null;
  projections: ProjectionRunDTO[] | null;
  presets: ProjectionPresetDTO[] | null;
  presetName: string;
  /** Source embedding run for the projection form (null = pick newest). */
  projRunId: string | null;
  projMethod: string;
  projParams: ProjectionParamValues;
  projSeed: number;
  /** Raw-axes field as parsed groups ("0,1;0,2" → [[0,1],[0,2]]); the
   *  round-trip source of the input (echo), valid or not. */
  projAxesGroups: number[][];
  /** Validation problem of the axes field (null = valid). */
  projAxesProblem: string | null;
  /** What the running/last projection job built — used to show the result. */
  pendingBuild: PendingBuild | null;
  loading: boolean;
  error: ExperimentError | null;

  loadCatalog: () => Promise<void>;
  loadRuns: () => Promise<void>;
  setModelId: (id: string) => void;
  setMode: (mode: PrepMode) => void;
  setBatchSize: (n: number) => void;
  startDownload: (modelId: string) => Promise<void>;
  startCompute: () => Promise<void>;
  loadProjectionCatalog: () => Promise<void>;
  loadProjections: () => Promise<ProjectionRunDTO[] | null>;
  setProjRunId: (id: string | null) => void;
  setProjMethod: (methodId: string) => void;
  setProjParam: (name: string, value: ProjectionParamValue) => void;
  /** Axes field emitted as parsed sets (single mode = one set of 2..4). */
  setProjAxesState: (sets: number[][], problem: string | null) => void;
  setProjSeed: (seed: number) => void;
  startProjection: (opts?: { components?: number[] }) => Promise<void>;
  deleteProjection: (id: string) => Promise<void>;
  deleteAllProjections: () => Promise<void>;
  loadPresets: () => Promise<void>;
  savePreset: () => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  applyPreset: (id: string) => void;
  setPresetName: (name: string) => void;
  tickActiveJob: () => Promise<void>;
  cancelActiveJob: () => Promise<void>;
}

/** Declared defaults of a method's parameter specs (no hidden values). */
export function defaultParamsFor(method: ProjectionMethodInfo | null): ProjectionParamValues {
  const values: ProjectionParamValues = {};
  for (const spec of method?.params ?? []) {
    values[spec.name] = spec.default;
  }
  return values;
}

function toError(err: unknown): ExperimentError {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  return { code: "unknown_error", message: err instanceof Error ? err.message : String(err) };
}

const JOB_POLL_MS = 1000;

export const useExperimentStore = create<ExperimentState>()((set, get) => ({
  models: null,
  previews: null,
  runs: null,
  activeJob: null,
  modelId: null,
  mode: "raw_fragment",
  batchSize: 16,
  projectionMethods: null,
  projections: null,
  presets: null,
  presetName: "",
  projRunId: null,
  projMethod: "pca",
  projParams: {},
  projSeed: 42,
  projAxesGroups: [],
  projAxesProblem: null,
  pendingBuild: null,
  loading: false,
  error: null,

  loadCatalog: async () => {
    try {
      const [models, previews] = await Promise.all([api.listModels(), api.getPreparationPreview()]);
      const current = get().modelId;
      const defaultModel = models.find((m) => m.is_default) ?? models[0] ?? null;
      set({
        models,
        previews,
        modelId: current ?? defaultModel?.model_id ?? null,
        error: null,
      });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  loadRuns: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      const runs = await api.listEmbeddingRuns(project.id);
      set({ runs, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  setModelId: (id) => set({ modelId: id }),
  setMode: (mode) => set({ mode }),
  setBatchSize: (n) => set({ batchSize: Math.min(128, Math.max(1, Math.round(n) || 1)) }),

  loadProjectionCatalog: async () => {
    try {
      const projectionMethods = await api.listProjectionMethods();
      const { projMethod } = get();
      const method =
        projectionMethods.find((m) => m.method_id === projMethod) ?? projectionMethods[0] ?? null;
      set({
        projectionMethods,
        projMethod: method?.method_id ?? projMethod,
        // Re-seed params only when they are empty or from another method.
        projParams:
          method && Object.keys(get().projParams).length === 0
            ? defaultParamsFor(method)
            : get().projParams,
        error: null,
      });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  loadProjections: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return null;
    try {
      const projections = await api.listProjections(project.id);
      set({ projections, error: null });
      return projections;
    } catch (err) {
      set({ error: toError(err) });
      return null;
    }
  },

  setProjRunId: (id) => set({ projRunId: id }),

  setProjMethod: (methodId) => {
    const method = get().projectionMethods?.find((m) => m.method_id === methodId) ?? null;
    set({
      projMethod: methodId,
      projParams: defaultParamsFor(method),
      projAxesGroups: [],
      projAxesProblem: null,
    });
  },

  setProjParam: (name, value) => {
    set({ projParams: { ...get().projParams, [name]: value } });
  },

  setProjAxesState: (sets, problem) => {
    set({
      projParams: { ...get().projParams, axes: sets[0] ?? [] },
      projAxesGroups: sets,
      projAxesProblem: problem,
    });
  },

  setProjSeed: (seed) => {
    set({ projSeed: Math.min(2_147_483_647, Math.max(0, Math.round(seed) || 0)) });
  },

  startProjection: async (opts) => {
    const project = useProjectStore.getState().current;
    const { projRunId, projMethod, projParams, projSeed, projAxesGroups, projAxesProblem, runs } =
      get();
    const axisSets =
      projMethod === "raw_axes" && projAxesProblem === null && projAxesGroups.length > 1
        ? projAxesGroups
        : null;
    // Default source run: the most recently updated one (inventory is sorted).
    const embeddingRunId = projRunId ?? runs?.[0]?.id ?? null;
    if (!project || !embeddingRunId) {
      set({
        error: {
          code: "no_embedding_run",
          message: "Нет запуска эмбеддингов — проектировать нечего.",
          hint: "Сначала рассчитайте эмбеддинги (раздел EXPERIMENTS).",
        },
      });
      return;
    }
    set({ error: null });
    try {
      let components: number[];
      let params: ProjectionParamValues = projParams;
      let pending: PendingBuild;
      const axes = projParams["axes"];
      if (axisSets) {
        // multi-plot 2D comparison: one pair → one projection run (backend)
        components = [2];
        params = { ...projParams };
        delete params["axes"]; // the pairs carry their own axes
        pending = {
          mode: "multi2d",
          sets: axisSets,
          embeddingRunId,
          seed: projSeed,
          standardize: params["standardize"] === true,
        };
      } else if (projMethod === "raw_axes" && Array.isArray(axes) && axes.length >= 2) {
        // raw_axes: one coordinate per selected axis — the component count is
        // derived from the axes, never [3,2] (backend enforces the same rule).
        components = [axes.length];
        pending = { mode: "single", components, embeddingRunId };
      } else {
        components = opts?.components ?? [3, 2];
        pending = { mode: "single", components, embeddingRunId };
      }
      const job = await api.computeProjection(project.id, {
        embedding_run_id: embeddingRunId,
        method: projMethod,
        components,
        params,
        seed: projSeed,
        ...(axisSets ? { axis_sets: axisSets } : {}),
      });
      set({ activeJob: job, projRunId: embeddingRunId, pendingBuild: pending });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  deleteProjection: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ error: null });
    try {
      await api.deleteProjection(project.id, id);
      await get().loadProjections();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  deleteAllProjections: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ error: null });
    try {
      await api.deleteAllProjections(project.id);
      await get().loadProjections();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  loadPresets: async () => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      const presets = await api.listPresets(project.id);
      set({ presets, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  savePreset: async () => {
    const project = useProjectStore.getState().current;
    const { presetName, projMethod, projParams, projSeed } = get();
    const name = presetName.trim();
    if (!project || !name) return;
    set({ error: null });
    try {
      await api.createPreset(project.id, {
        name,
        method: projMethod,
        params: projParams,
        seed: projSeed,
      });
      set({ presetName: "" });
      await get().loadPresets();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  deletePreset: async (id) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    try {
      await api.deletePreset(project.id, id);
      await get().loadPresets();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  applyPreset: (id) => {
    const preset = get().presets?.find((p) => p.id === id);
    if (!preset) return;
    const presetAxes = preset.params["axes"];
    set({
      projMethod: preset.method,
      projParams: { ...preset.params },
      projSeed: preset.seed,
      projAxesGroups: Array.isArray(presetAxes) && presetAxes.length > 0 ? [presetAxes] : [],
      projAxesProblem: null,
    });
  },

  setPresetName: (name) => set({ presetName: name }),

  startDownload: async (modelId) => {
    const project = useProjectStore.getState().current;
    if (!project) return;
    set({ error: null });
    try {
      const job = await api.downloadModel(project.id, modelId);
      set({ activeJob: job });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  startCompute: async () => {
    const project = useProjectStore.getState().current;
    const { modelId, mode, batchSize } = get();
    if (!project || !modelId) return;
    set({ error: null });
    try {
      const job = await api.computeEmbeddings(project.id, {
        model_id: modelId,
        mode,
        batch_size: batchSize,
      });
      set({ activeJob: job });
    } catch (err) {
      set({ error: toError(err) });
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
        const [, , projections] = await Promise.all([
          get().loadRuns(),
          get().loadCatalog(),
          get().loadProjections(),
        ]);
        const pending = get().pendingBuild;
        if (job.state === "done") {
          if (job.kind === "projection" && pending && projections) {
            // show what the build produced (single/multi/4D) right away —
            // referencing the runs by the ids the job reported (never by
            // guessing from the inventory order)
            const rawIds = (job.result as { projection_run_ids?: unknown } | null)?.[
              "projection_run_ids"
            ];
            const builtRunIds = Array.isArray(rawIds)
              ? rawIds.filter((x): x is string => typeof x === "string")
              : undefined;
            useSpaceStore.getState().applyBuiltProjections(projections, pending, builtRunIds);
          } else if (job.kind === "projection" || job.kind === "embed") {
            // no pending descriptor (job from before a reload): refresh what
            // is on screen so staleness badges/points stay honest
            void useSpaceStore.getState().reloadActive();
          }
        }
        set({ pendingBuild: null });
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
}));

export { JOB_POLL_MS };
