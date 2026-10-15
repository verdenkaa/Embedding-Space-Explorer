/**
 * Experiment store: embedding models & runs (stage 2) + projection catalog,
 * form, inventory and compute job (stage 3). Depends on projectStore one-way
 * (reads the current project id); later stages add slices/clustering/metrics
 * (TZ §2.2).
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
  ProjectionRunDTO,
} from "../api/types";
import { useProjectStore } from "./projectStore";

export interface ExperimentError {
  code: string;
  message: string;
  hint?: string;
}

export type ProjectionParamValues = Record<string, number | boolean | string>;

interface ExperimentState {
  models: ModelInfo[] | null;
  previews: PreparationPreviews | null;
  runs: EmbeddingRunDTO[] | null;
  activeJob: JobInfo | null;
  /* embeddings compute form */
  modelId: string | null;
  mode: PrepMode;
  batchSize: number;
  /* projections (stage 3) */
  projectionMethods: ProjectionMethodInfo[] | null;
  projections: ProjectionRunDTO[] | null;
  /** Source embedding run for the projection form (null = pick newest). */
  projRunId: string | null;
  projMethod: string;
  projParams: ProjectionParamValues;
  projSeed: number;
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
  loadProjections: () => Promise<void>;
  setProjRunId: (id: string | null) => void;
  setProjMethod: (methodId: string) => void;
  setProjParam: (name: string, value: number | boolean | string) => void;
  setProjSeed: (seed: number) => void;
  startProjection: () => Promise<void>;
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
  projRunId: null,
  projMethod: "pca",
  projParams: {},
  projSeed: 42,
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
    if (!project) return;
    try {
      const projections = await api.listProjections(project.id);
      set({ projections, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  setProjRunId: (id) => set({ projRunId: id }),

  setProjMethod: (methodId) => {
    const method = get().projectionMethods?.find((m) => m.method_id === methodId) ?? null;
    set({ projMethod: methodId, projParams: defaultParamsFor(method) });
  },

  setProjParam: (name, value) => {
    set({ projParams: { ...get().projParams, [name]: value } });
  },

  setProjSeed: (seed) => {
    set({ projSeed: Math.min(2_147_483_647, Math.max(0, Math.round(seed) || 0)) });
  },

  startProjection: async () => {
    const project = useProjectStore.getState().current;
    const { projRunId, projMethod, projParams, projSeed, runs } = get();
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
      const job = await api.computeProjection(project.id, {
        embedding_run_id: embeddingRunId,
        method: projMethod,
        components: [3, 2],
        params: projParams,
        seed: projSeed,
      });
      set({ activeJob: job, projRunId: embeddingRunId });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

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
        await Promise.all([get().loadRuns(), get().loadCatalog(), get().loadProjections()]);
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
