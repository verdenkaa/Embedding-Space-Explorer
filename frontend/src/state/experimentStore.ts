/**
 * Experiment store (stage 2 scope: embedding models & runs).
 * Depends on projectStore one-way (reads the current project id); later
 * stages extend it with projections/slices/clustering/metrics (TZ §2.2).
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type { EmbeddingRunDTO, JobInfo, ModelInfo, PrepMode, PreparationPreviews } from "../api/types";
import { useProjectStore } from "./projectStore";

export interface ExperimentError {
  code: string;
  message: string;
  hint?: string;
}

interface ExperimentState {
  models: ModelInfo[] | null;
  previews: PreparationPreviews | null;
  runs: EmbeddingRunDTO[] | null;
  activeJob: JobInfo | null;
  /* compute form */
  modelId: string | null;
  mode: PrepMode;
  batchSize: number;
  loading: boolean;
  error: ExperimentError | null;

  loadCatalog: () => Promise<void>;
  loadRuns: () => Promise<void>;
  setModelId: (id: string) => void;
  setMode: (mode: PrepMode) => void;
  setBatchSize: (n: number) => void;
  startDownload: (modelId: string) => Promise<void>;
  startCompute: () => Promise<void>;
  tickActiveJob: () => Promise<void>;
  cancelActiveJob: () => Promise<void>;
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
        await Promise.all([get().loadRuns(), get().loadCatalog()]);
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
