/**
 * Research workspace store (zustand — the single state manager).
 *
 * Holds: the workspace file tree of the CURRENT project, the selected path
 * (file or directory), the loaded text document and all file operations
 * (create / rename / delete / open-folder). Everything is server-backed:
 * documents live on disk under <project>/workspace/, never in localStorage.
 *
 * Project binding: every action resolves the project id at call time from
 * projectStore; ResearchSection resets the store when the project changes,
 * so state of another project is never shown or written.
 */

import { create } from "zustand";

import { ApiError, workspaceApi } from "../api/client";
import type {
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceFileContent,
} from "../api/types";
import { useNotebookStore } from "./notebookStore";
import { useProjectStore } from "./projectStore";

export interface ResearchError {
  code: string;
  message: string;
  hint?: string;
}

interface ResearchState {
  /* data */
  tree: WorkspaceEntry[] | null;
  /** Absolute workspace path (display/copy only — never sent to the API). */
  treeRoot: string | null;
  treeTruncated: boolean;
  treeLoading: boolean;
  selectedPath: string | null;
  /** Loaded text content of the selected FILE (null for dirs/no selection). */
  file: WorkspaceFileContent | null;
  fileLoading: boolean;
  /** A file operation is in flight (buttons disable). */
  busy: boolean;
  error: ResearchError | null;
  /** Transient success notice (e.g. open-folder result). */
  notice: string | null;

  /* actions */
  reset: () => void;
  loadTree: () => Promise<void>;
  selectPath: (path: string | null) => Promise<void>;
  createPath: (
    path: string,
    kind: WorkspaceEntryKind,
    content?: string,
  ) => Promise<boolean>;
  renamePath: (fromPath: string, toPath: string) => Promise<boolean>;
  deletePath: (path: string, confirm?: boolean) => Promise<boolean>;
  openFolder: (sub?: string) => Promise<void>;
  dismissNotice: () => void;
  clearError: () => void;
}

function currentProjectId(): string | null {
  return useProjectStore.getState().current?.id ?? null;
}

function toError(err: unknown): ResearchError {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  return {
    code: "unknown_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Guard for switching away from a dirty notebook (TZ §5.2: warn before
 * losing unsaved changes). Returns false when the user chose to stay.
 */
function confirmLeaveDirtyNotebook(targetPath: string | null): boolean {
  const nb = useNotebookStore.getState();
  if (!nb.doc || !nb.dirty) return true;
  if (targetPath === nb.doc.path) return true;
  return window.confirm(
    `Блокнот ${nb.doc.path} имеет несохранённые изменения. ` +
      "При переключении они будут потеряны. Продолжить?",
  );
}

const EMPTY: Pick<
  ResearchState,
  | "tree"
  | "treeRoot"
  | "treeTruncated"
  | "treeLoading"
  | "selectedPath"
  | "file"
  | "fileLoading"
  | "busy"
  | "error"
  | "notice"
> = {
  tree: null,
  treeRoot: null,
  treeTruncated: false,
  treeLoading: false,
  selectedPath: null,
  file: null,
  fileLoading: false,
  busy: false,
  error: null,
  notice: null,
};

export const useResearchStore = create<ResearchState>()((set, get) => ({
  ...EMPTY,

  reset: () => set({ ...EMPTY }),

  loadTree: async () => {
    const pid = currentProjectId();
    if (!pid) return;
    set({ treeLoading: true, error: null });
    try {
      const data = await workspaceApi.getTree(pid);
      // Ignore a late response if the project changed while in flight.
      if (currentProjectId() !== pid) return;
      set({
        tree: data.entries,
        treeRoot: data.root,
        treeTruncated: data.truncated,
        treeLoading: false,
      });
    } catch (err) {
      if (currentProjectId() !== pid) return;
      set({ treeLoading: false, error: toError(err) });
    }
  },

  selectPath: async (path) => {
    const pid = currentProjectId();
    if (!pid) return;
    if (path === null) {
      if (!confirmLeaveDirtyNotebook(null)) return;
      set({ selectedPath: null, file: null });
      return;
    }
    if (!confirmLeaveDirtyNotebook(path)) return;
    const entries = get().tree ?? [];
    const entry = entries.find((e) => e.path === path);
    if (entry?.kind === "dir") {
      // Directories are selection targets for rename/delete only.
      set({ selectedPath: path, file: null, error: null });
      return;
    }
    set({ selectedPath: path, file: null, fileLoading: true, error: null });
    try {
      const file = await workspaceApi.getFile(pid, path);
      if (currentProjectId() !== pid || get().selectedPath !== path) return;
      set({ file, fileLoading: false });
    } catch (err) {
      if (currentProjectId() !== pid) return;
      set({ fileLoading: false, error: toError(err) });
    }
  },

  createPath: async (path, kind, content = "") => {
    const pid = currentProjectId();
    if (!pid) return false;
    set({ busy: true, error: null });
    try {
      await workspaceApi.create(pid, { path, content, kind });
      await get().loadTree();
      if (kind === "file") await get().selectPath(path);
      set({ busy: false, notice: `Создано: ${path}` });
      return true;
    } catch (err) {
      set({ busy: false, error: toError(err) });
      return false;
    }
  },

  renamePath: async (fromPath, toPath) => {
    const pid = currentProjectId();
    if (!pid) return false;
    const nb = useNotebookStore.getState();
    if (nb.doc && (nb.doc.path === fromPath || nb.doc.path.startsWith(`${fromPath}/`))) {
      if (
        nb.dirty &&
        !window.confirm(
          `Блокнот ${nb.doc.path} имеет несохранённые изменения. ` +
            "Переименование закроет редактор, изменения будут потеряны. Продолжить?",
        )
      ) {
        return false;
      }
      nb.reset();
    }
    set({ busy: true, error: null });
    try {
      await workspaceApi.rename(pid, fromPath, toPath);
      const wasSelected = get().selectedPath === fromPath;
      const openedFile = get().file?.path === fromPath;
      await get().loadTree();
      if (wasSelected || openedFile) await get().selectPath(toPath);
      set({ busy: false, notice: `Переименовано: ${fromPath} → ${toPath}` });
      return true;
    } catch (err) {
      set({ busy: false, error: toError(err) });
      return false;
    }
  },

  deletePath: async (path, confirm = false) => {
    const pid = currentProjectId();
    if (!pid) return false;
    const nb = useNotebookStore.getState();
    if (nb.doc && (nb.doc.path === path || nb.doc.path.startsWith(`${path}/`))) {
      if (
        nb.dirty &&
        !window.confirm(
          `Блокнот ${nb.doc.path} имеет несохранённые изменения и будет удалён. Продолжить?`,
        )
      ) {
        return false;
      }
      nb.reset();
    }
    set({ busy: true, error: null });
    try {
      await workspaceApi.remove(pid, path, confirm);
      const selected = get().selectedPath;
      if (selected === path || selected?.startsWith(`${path}/`)) {
        set({ selectedPath: null, file: null });
      }
      await get().loadTree();
      set({ busy: false, notice: `Удалено: ${path}` });
      return true;
    } catch (err) {
      set({ busy: false, error: toError(err) });
      return false;
    }
  },

  openFolder: async (sub = "") => {
    const pid = currentProjectId();
    if (!pid) return;
    set({ error: null });
    try {
      const result = await workspaceApi.openFolder(pid, sub);
      if (result.opened) {
        set({ notice: `Папка открыта: ${result.path}` });
      } else {
        set({
          error: {
            code: "open_folder_failed",
            message:
              result.error ??
              "Не удалось открыть папку в файловом менеджере операционной системы.",
            hint: `Скопируйте путь и откройте вручную: ${result.path}`,
          },
        });
      }
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  dismissNotice: () => set({ notice: null }),
  clearError: () => set({ error: null }),
}));
