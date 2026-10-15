/**
 * Project/corpus store (zustand — the single state manager, TZ §2.2).
 *
 * Holds: project list & current project, file list, selected file (detail +
 * content), selection state (active fragment — shared with future 3D/2D views
 * by fragment id, TZ §4.4), located fragments from editor selection, changes
 * report, active background job with polling.
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type {
  ChangesReport,
  CreateProjectRequest,
  FileContent,
  FileDetail,
  FileSummary,
  FragmentMeta,
  FragmentSearchResponse,
  JobInfo,
  ProjectInfo,
  ProjectSummary,
  StalenessReport,
} from "../api/types";

export interface ProjectError {
  code: string;
  message: string;
  hint?: string;
}

interface ProjectState {
  /* data */
  projects: ProjectSummary[] | null;
  current: ProjectInfo | null;
  files: FileSummary[] | null;
  selectedFileId: string | null;
  fileDetail: FileDetail | null;
  fileContent: FileContent | null;
  activeFragmentId: string | null;
  locatedFragments: FragmentMeta[] | null;
  locatedNote: string | null;
  searchQuery: string;
  searchResults: FragmentSearchResponse | null;
  changes: ChangesReport | null;
  changesLoading: boolean;
  staleness: StalenessReport | null;
  activeJob: JobInfo | null;
  loading: boolean;
  error: ProjectError | null;

  /* actions */
  loadProjects: () => Promise<void>;
  createProject: (payload: CreateProjectRequest) => Promise<ProjectInfo | null>;
  openProject: (projectId: string) => Promise<void>;
  closeProject: () => void;
  deleteProject: (projectId: string) => Promise<void>;
  refreshProject: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  selectFile: (fileId: string) => Promise<void>;
  selectFragment: (fragment: FragmentMeta | null) => Promise<void>;
  clearSelection: () => void;
  locateFromEditorSelection: (startLine: number, endLine: number) => Promise<void>;
  setSearchQuery: (query: string) => void;
  runSearch: () => Promise<void>;
  loadChanges: () => Promise<void>;
  closeChanges: () => void;
  checkStaleness: () => Promise<void>;
  startIndex: () => Promise<void>;
  tickActiveJob: () => Promise<void>;
  cancelActiveJob: () => Promise<void>;
}

function toError(err: unknown): ProjectError {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  return {
    code: "unknown_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  projects: null,
  current: null,
  files: null,
  selectedFileId: null,
  fileDetail: null,
  fileContent: null,
  activeFragmentId: null,
  locatedFragments: null,
  locatedNote: null,
  searchQuery: "",
  searchResults: null,
  changes: null,
  changesLoading: false,
  staleness: null,
  activeJob: null,
  loading: false,
  error: null,

  loadProjects: async () => {
    try {
      const projects = await api.listProjects();
      set({ projects, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  createProject: async (payload) => {
    set({ loading: true, error: null });
    try {
      const project = await api.createProject(payload);
      set({ projects: null, loading: false });
      await get().loadProjects();
      await get().openProject(project.id);
      return project;
    } catch (err) {
      set({ loading: false, error: toError(err) });
      return null;
    }
  },

  openProject: async (projectId) => {
    set({
      loading: true,
      error: null,
      selectedFileId: null,
      fileDetail: null,
      fileContent: null,
      activeFragmentId: null,
      locatedFragments: null,
      locatedNote: null,
      searchQuery: "",
      searchResults: null,
      changes: null,
      staleness: null,
    });
    try {
      const current = await api.getProject(projectId);
      set({ current, loading: false });
      await get().refreshFiles();
      if (current.stats?.running_job_id) {
        const job = await api.getJob(projectId, current.stats.running_job_id);
        set({ activeJob: job });
      }
    } catch (err) {
      set({ loading: false, error: toError(err) });
    }
  },

  closeProject: () => {
    set({
      current: null,
      files: null,
      selectedFileId: null,
      fileDetail: null,
      fileContent: null,
      activeFragmentId: null,
      locatedFragments: null,
      locatedNote: null,
      searchQuery: "",
      searchResults: null,
      changes: null,
      staleness: null,
      activeJob: null,
      error: null,
    });
  },

  deleteProject: async (projectId) => {
    try {
      await api.deleteProject(projectId);
      const { current } = get();
      if (current?.id === projectId) {
        get().closeProject();
      }
      await get().loadProjects();
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  refreshProject: async () => {
    const { current } = get();
    if (!current) return;
    try {
      const fresh = await api.getProject(current.id);
      set({ current: fresh });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  refreshFiles: async () => {
    const { current } = get();
    if (!current) return;
    try {
      const files = await api.listFiles(current.id);
      set({ files, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  selectFile: async (fileId) => {
    const { current } = get();
    if (!current) return;
    set({ loading: true, error: null });
    try {
      const [fileDetail, fileContent] = await Promise.all([
        api.getFile(current.id, fileId),
        api.getFileContent(current.id, fileId),
      ]);
      set({
        selectedFileId: fileId,
        fileDetail,
        fileContent,
        activeFragmentId: null,
        locatedFragments: null,
        locatedNote: null,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: toError(err) });
    }
  },

  selectFragment: async (fragment) => {
    if (fragment === null) {
      set({ activeFragmentId: null });
      return;
    }
    const { selectedFileId } = get();
    if (fragment.file_id !== selectedFileId) {
      await get().selectFile(fragment.file_id);
    }
    set({ activeFragmentId: fragment.id });
  },

  clearSelection: () => {
    set({ activeFragmentId: null, locatedFragments: null, locatedNote: null });
  },

  locateFromEditorSelection: async (startLine, endLine) => {
    const { current, selectedFileId } = get();
    if (!current || !selectedFileId) return;
    try {
      const located = await api.locateFragments(current.id, selectedFileId, startLine, endLine);
      set({ locatedFragments: located.fragments, locatedNote: located.note });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },

  runSearch: async () => {
    const { current, searchQuery } = get();
    if (!current) return;
    if (!searchQuery.trim()) {
      set({ searchResults: null });
      return;
    }
    try {
      const searchResults = await api.searchFragments(current.id, {
        q: searchQuery.trim(),
        limit: 200,
      });
      set({ searchResults, error: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  loadChanges: async () => {
    const { current } = get();
    if (!current) return;
    set({ changesLoading: true, error: null });
    try {
      const changes = await api.getChanges(current.id);
      set({ changes, changesLoading: false });
    } catch (err) {
      set({ changesLoading: false, error: toError(err) });
    }
  },

  closeChanges: () => set({ changes: null, changesLoading: false }),

  checkStaleness: async () => {
    const { current, activeJob } = get();
    if (!current) return;
    // Skip while a job runs: the index is legitimately in flux.
    if (activeJob && (activeJob.state === "queued" || activeJob.state === "running")) return;
    try {
      const staleness = await api.getStaleness(current.id);
      set({ staleness });
    } catch (err) {
      // Background indicator only: never spam the error banner for it, but
      // leave a console trace (e.g. 404 => backend predates the endpoint and
      // must be restarted after applying patches).
      console.warn("[staleness] check failed:", err instanceof Error ? err.message : err);
      set({ staleness: null });
    }
  },

  startIndex: async () => {
    const { current } = get();
    if (!current) return;
    set({ error: null });
    try {
      const job = await api.startIndex(current.id);
      set({ activeJob: job, changes: null, staleness: null });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  tickActiveJob: async () => {
    const { current, activeJob } = get();
    if (!current || !activeJob) return;
    if (activeJob.state !== "queued" && activeJob.state !== "running") return;
    try {
      const job = await api.getJob(current.id, activeJob.id);
      set({ activeJob: job });
      if (job.state === "done" || job.state === "failed" || job.state === "cancelled") {
        await Promise.all([get().refreshFiles(), get().refreshProject()]);
        await get().checkStaleness();
      }
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  cancelActiveJob: async () => {
    const { current, activeJob } = get();
    if (!current || !activeJob) return;
    try {
      const job = await api.cancelJob(current.id, activeJob.id);
      set({ activeJob: job });
    } catch (err) {
      set({ error: toError(err) });
    }
  },
}));
