/**
 * Notebook store (zustand): the open .ipynb document, its kernel session and
 * cell executions.
 *
 * Data flow (all server-backed — the .ipynb on disk is the source of truth):
 * open() loads via the notebook API; edits mark the doc dirty; save() sends
 * the full notebook (nbformat-normalized server-side) with base_mtime for
 * conflict detection. Executions: ensureSession() → execute → poll until the
 * execution leaves "running" (the app's standard polling model); outputs are
 * written into the cell so a save preserves code AND results.
 *
 * Session semantics: one kernel per (project, notebook path) — state survives
 * cell runs and editor switches; the backend reaps idle kernels. A project
 * switch never silently retargets a kernel: the store keeps the project id it
 * was opened with and flushes/closes on reset.
 */

import { create } from "zustand";

import { ApiError, notebookApi } from "../api/client";
import type {
  CellOutput,
  KernelSessionDTO,
  NotebookCellJson,
  NotebookJson,
} from "../api/types";

export interface NotebookError {
  code: string;
  message: string;
  hint?: string;
}

export interface NotebookDoc {
  path: string;
  projectId: string;
  notebook: NotebookJson;
  savedMtime: number | null;
}

const EXECUTION_POLL_MS = 250;
const SESSION_POLL_MS = 300;
const SESSION_READY_TIMEOUT_MS = 90_000;

interface NotebookState {
  doc: NotebookDoc | null;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  /** nbformat validation problems of the loaded/saved file (banner, not fatal). */
  problems: string[];
  /** True when the file on disk changed since load — save needs a decision. */
  conflict: boolean;
  error: NotebookError | null;
  notice: string | null;

  session: KernelSessionDTO | null;
  /** Index of the cell whose execution is in flight (busy indicator). */
  runningCell: number | null;
  selectedCell: number;
  /** Cell keys (index-stable ids) currently in edit mode. */
  editing: Record<string, boolean>;

  /* lifecycle */
  open: (projectId: string, path: string) => Promise<void>;
  /** Save if dirty (best effort), then drop everything (project switch/close). */
  flushAndReset: () => Promise<void>;
  reset: () => void;
  save: (opts?: { force?: boolean }) => Promise<boolean>;

  /* editing */
  setCellSource: (index: number, source: string) => void;
  addCell: (afterIndex: number, type: "code" | "markdown") => void;
  deleteCell: (index: number) => void;
  moveCell: (index: number, direction: -1 | 1) => void;
  convertCell: (index: number, type: "code" | "markdown") => void;
  setSelectedCell: (index: number) => void;
  setEditing: (key: string, editing: boolean) => void;
  clearAllOutputs: () => void;

  /* kernel */
  ensureSession: () => Promise<KernelSessionDTO | null>;
  refreshSession: () => Promise<void>;
  executeCell: (index: number) => Promise<void>;
  executeCells: (indices: number[]) => Promise<void>;
  stopExecution: () => Promise<void>;
  restartKernel: () => Promise<void>;
  shutdownSession: () => Promise<void>;

  dismissNotice: () => void;
  clearError: () => void;
}

function toError(err: unknown): NotebookError {
  if (err instanceof ApiError) return { code: err.code, message: err.message, hint: err.hint };
  return { code: "unknown_error", message: err instanceof Error ? err.message : String(err) };
}

let uidCounter = 0;
export function nextCellId(): string {
  uidCounter += 1;
  return `cell-${Date.now().toString(36)}-${uidCounter}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Stable key per cell for UI maps (edit mode): prefer the nbformat id. */
export function cellKey(cell: NotebookCellJson, index: number): string {
  return typeof cell.id === "string" && cell.id ? cell.id : `idx-${index}`;
}

function normalizeCells(cells: NotebookCellJson[]): NotebookCellJson[] {
  return cells.map((cell) => ({
    ...cell,
    source: Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? ""),
    metadata: cell.metadata ?? {},
    id: typeof cell.id === "string" && cell.id ? cell.id : nextCellId(),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useNotebookStore = create<NotebookState>()((set, get) => ({
  doc: null,
  dirty: false,
  saving: false,
  loading: false,
  problems: [],
  conflict: false,
  error: null,
  notice: null,
  session: null,
  runningCell: null,
  selectedCell: 0,
  editing: {},

  open: async (projectId, path) => {
    set({ loading: true, error: null, conflict: false, problems: [] });
    try {
      const content = await notebookApi.getContent(projectId, path);
      const notebook: NotebookJson = {
        ...content.notebook,
        cells: normalizeCells(content.notebook.cells ?? []),
      };
      set({
        doc: { path, projectId, notebook, savedMtime: content.mtime },
        dirty: false,
        loading: false,
        problems: content.problems,
        selectedCell: 0,
        editing: {},
        runningCell: null,
      });
      // Re-attach to a live session of THIS notebook if the backend has one
      // (editor switches and section switches must not kill kernels).
      try {
        const sessions = await notebookApi.listSessions(projectId);
        const live = sessions.find((s) => s.path === path && s.state !== "dead");
        set({ session: live ?? null });
      } catch {
        set({ session: null });
      }
    } catch (err) {
      set({ loading: false, doc: null, error: toError(err) });
    }
  },

  flushAndReset: async () => {
    const { doc, dirty, save } = get();
    if (doc && dirty) {
      // Best effort: the doc belongs to `doc.projectId`, not the new project.
      await save().catch(() => undefined);
    }
    get().reset();
  },

  reset: () => {
    set({
      doc: null,
      dirty: false,
      saving: false,
      loading: false,
      problems: [],
      conflict: false,
      error: null,
      notice: null,
      session: null,
      runningCell: null,
      selectedCell: 0,
      editing: {},
    });
  },

  save: async (opts) => {
    const { doc } = get();
    if (!doc) return false;
    set({ saving: true, error: null });
    try {
      const result = await notebookApi.saveContent(doc.projectId, {
        path: doc.path,
        notebook: doc.notebook,
        base_mtime: opts?.force ? null : doc.savedMtime,
        force: opts?.force ?? false,
      });
      set({
        saving: false,
        dirty: false,
        conflict: false,
        problems: result.problems,
        doc: { ...doc, savedMtime: result.mtime },
        notice: `Сохранено: ${doc.path}`,
      });
      return true;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.code === "workspace_conflict") {
        set({ saving: false, conflict: true });
      } else {
        set({ saving: false, error: toError(err) });
      }
      return false;
    }
  },

  /* ------------------------------- editing ------------------------------- */

  setCellSource: (index, source) => {
    const { doc } = get();
    if (!doc) return;
    const cells = doc.notebook.cells.map((cell, i) => (i === index ? { ...cell, source } : cell));
    set({ doc: { ...doc, notebook: { ...doc.notebook, cells } }, dirty: true });
  },

  addCell: (afterIndex, type) => {
    const { doc } = get();
    if (!doc) return;
    const cell: NotebookCellJson =
      type === "code"
        ? { cell_type: "code", id: nextCellId(), source: "", metadata: {}, outputs: [], execution_count: null }
        : { cell_type: "markdown", id: nextCellId(), source: "", metadata: {} };
    const cells = [...doc.notebook.cells];
    cells.splice(afterIndex + 1, 0, cell);
    set({
      doc: { ...doc, notebook: { ...doc.notebook, cells } },
      dirty: true,
      selectedCell: afterIndex + 1,
      editing: { ...get().editing, [cellKey(cell, afterIndex + 1)]: true },
    });
  },

  deleteCell: (index) => {
    const { doc } = get();
    if (!doc) return;
    const cells = doc.notebook.cells.filter((_, i) => i !== index);
    const selected = Math.min(get().selectedCell, Math.max(cells.length - 1, 0));
    set({ doc: { ...doc, notebook: { ...doc.notebook, cells } }, dirty: true, selectedCell: selected });
  },

  moveCell: (index, direction) => {
    const { doc } = get();
    if (!doc) return;
    const target = index + direction;
    const cells = [...doc.notebook.cells];
    if (target < 0 || target >= cells.length) return;
    [cells[index], cells[target]] = [cells[target], cells[index]];
    set({ doc: { ...doc, notebook: { ...doc.notebook, cells } }, dirty: true, selectedCell: target });
  },

  convertCell: (index, type) => {
    const { doc } = get();
    if (!doc) return;
    const cells = doc.notebook.cells.map((cell, i) => {
      if (i !== index) return cell;
      if (type === "code") {
        return {
          ...cell,
          cell_type: "code" as const,
          outputs: cell.outputs ?? [],
          execution_count: cell.execution_count ?? null,
        };
      }
      const { outputs: _outputs, execution_count: _count, ...rest } = cell;
      return { ...rest, cell_type: "markdown" as const };
    });
    set({ doc: { ...doc, notebook: { ...doc.notebook, cells } }, dirty: true });
  },

  setSelectedCell: (index) => set({ selectedCell: index }),

  setEditing: (key, editing) => set({ editing: { ...get().editing, [key]: editing } }),

  clearAllOutputs: () => {
    const { doc } = get();
    if (!doc) return;
    const cells = doc.notebook.cells.map((cell) =>
      cell.cell_type === "code" ? { ...cell, outputs: [], execution_count: null } : cell,
    );
    set({ doc: { ...doc, notebook: { ...doc.notebook, cells } }, dirty: true });
  },

  /* -------------------------------- kernel -------------------------------- */

  ensureSession: async () => {
    const { doc, session } = get();
    if (!doc) return null;
    if (session && (session.state === "ready" || session.state === "starting" || session.state === "restarting")) {
      if (session.state === "ready") return session;
    } else {
      try {
        const started = await notebookApi.startSession(doc.projectId, doc.path);
        set({ session: started, error: null });
      } catch (err) {
        set({ error: toError(err) });
        return null;
      }
    }
    // Poll until ready (kernel boot takes ~1 s).
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
    let current = get().session;
    while (current && current.state !== "ready" && Date.now() < deadline) {
      await sleep(SESSION_POLL_MS);
      if (get().doc?.path !== doc.path) return null; // switched away
      try {
        current = await notebookApi.getSession(doc.projectId, current.session_id);
        set({ session: current });
      } catch (err) {
        set({ error: toError(err) });
        return null;
      }
    }
    if (current?.state === "ready") return current;
    if (current && (current.state === "error" || current.state === "dead")) {
      set({
        error: {
          code: "kernel_failed",
          message: current.error ?? "Ядро не запустилось.",
          hint: "Попробуйте «Перезапуск ядра». Код Python выполняется в том же окружении, что и backend.",
        },
      });
    }
    return null;
  },

  refreshSession: async () => {
    const { doc, session } = get();
    if (!doc || !session) return;
    try {
      const fresh = await notebookApi.getSession(doc.projectId, session.session_id);
      set({ session: fresh });
    } catch {
      set({ session: null });
    }
  },

  executeCell: async (index) => {
    const { doc } = get();
    if (!doc) return;
    const cell = doc.notebook.cells[index];
    if (!cell || cell.cell_type !== "code") return;
    if (get().runningCell !== null) return; // one execution per session

    const session = await get().ensureSession();
    if (!session) return;

    let response;
    try {
      response = await notebookApi.execute(doc.projectId, session.session_id, cellSourceString(cell));
    } catch (err) {
      set({ error: toError(err) });
      return;
    }
    set({ runningCell: index });

    const applyExecution = (outputs: CellOutput[], executionCount: number | null) => {
      const current = get().doc;
      if (!current || current.path !== doc.path) return;
      const cells = current.notebook.cells.map((c, i) =>
        i === index ? { ...c, outputs, execution_count: executionCount ?? c.execution_count } : c,
      );
      set({ doc: { ...current, notebook: { ...current.notebook, cells } }, dirty: true });
    };

    try {
      for (;;) {
        await sleep(EXECUTION_POLL_MS);
        if (get().doc?.path !== doc.path) return;
        let execution;
        try {
          execution = await notebookApi.getExecution(
            doc.projectId,
            session.session_id,
            response.execution_id,
          );
        } catch (err) {
          set({ error: toError(err), runningCell: null });
          return;
        }
        applyExecution(execution.outputs, execution.execution_count);
        if (execution.status !== "running") {
          if (execution.status === "interrupted") {
            set({ notice: "Выполнение остановлено пользователем." });
          } else if (execution.status === "error") {
            set({
              error: {
                code: "execution_failed",
                message: execution.error ?? "Выполнение завершилось ошибкой ядра.",
              },
            });
          }
          break;
        }
      }
    } finally {
      set({ runningCell: null });
      void get().refreshSession();
    }
  },

  executeCells: async (indices) => {
    for (const index of indices) {
      if (get().doc === null) return;
      await get().executeCell(index);
    }
  },

  stopExecution: async () => {
    const { doc, session } = get();
    if (!doc || !session) return;
    try {
      const fresh = await notebookApi.interrupt(doc.projectId, session.session_id);
      set({ session: fresh });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  restartKernel: async () => {
    const { doc } = get();
    if (!doc) return;
    let session = get().session;
    try {
      if (!session) {
        session = await notebookApi.startSession(doc.projectId, doc.path);
      } else {
        session = await notebookApi.restart(doc.projectId, session.session_id);
      }
      set({ session, error: null });
    } catch (err) {
      set({ error: toError(err) });
      return;
    }
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
    while (session && session.state !== "ready" && Date.now() < deadline) {
      await sleep(SESSION_POLL_MS);
      if (get().doc?.path !== doc.path) return;
      try {
        session = await notebookApi.getSession(doc.projectId, session.session_id);
        set({ session });
      } catch (err) {
        set({ error: toError(err) });
        return;
      }
    }
    // After a restart the Python state is gone: execution counters are reset
    // (outputs stay visible but stale, exactly like Jupyter does).
    const current = get().doc;
    if (current && session?.state === "ready") {
      const cells = current.notebook.cells.map((c) =>
        c.cell_type === "code" ? { ...c, execution_count: null } : c,
      );
      set({ doc: { ...current, notebook: { ...current.notebook, cells } }, dirty: true });
    }
  },

  shutdownSession: async () => {
    const { doc, session } = get();
    if (!doc || !session) return;
    try {
      await notebookApi.closeSession(doc.projectId, session.session_id);
      set({ session: null, notice: "Ядро остановлено." });
    } catch (err) {
      set({ error: toError(err) });
    }
  },

  dismissNotice: () => set({ notice: null }),
  clearError: () => set({ error: null }),
}));

export function cellSourceString(cell: NotebookCellJson): string {
  return Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
}
