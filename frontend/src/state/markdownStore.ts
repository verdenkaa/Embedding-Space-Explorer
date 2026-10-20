/**
 * Markdown note store (zustand): the open .md document of the research
 * workspace (TZ §6).
 *
 * Data flow (server-backed like notebookStore — the .md file on disk is the
 * source of truth, never localStorage): open() loads via the workspace API;
 * edits (Crepe WYSIWYG / Monaco source) update `content` and mark dirty by
 * COMPARISON with savedContent (so undo back to the saved text clears the
 * dirty flag honestly); save() sends base_mtime for optimistic concurrency.
 *
 * External changes (a notebook kernel writing into notes/ is a first-class
 * scenario): recheckExternal() runs on window focus — a clean document is
 * silently refreshed (reloadToken forces the WYSIWYG editor to remount with
 * the new text); a dirty document surfaces the conflict banner instead of
 * overwriting anything.
 *
 * Project binding: the doc keeps the project id it was opened with; save and
 * flushAndReset always talk to THAT project, so a project switch can never
 * write a note into another project's workspace.
 */

import { create } from "zustand";

import { ApiError, workspaceApi } from "../api/client";
import { useProjectStore } from "./projectStore";

/** Editor presentation of the SAME markdown source (TZ §6.2). */
export type NoteMode = "wysiwyg" | "source" | "preview" | "split";

export interface NoteDoc {
  path: string;
  projectId: string;
  /** Current (possibly unsaved) markdown source. */
  content: string;
  /** The content as last loaded from / saved to disk (dirty comparison). */
  savedContent: string;
  savedMtime: number | null;
}

export interface MarkdownError {
  code: string;
  message: string;
  hint?: string;
}

interface MarkdownState {
  doc: NoteDoc | null;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  /** Disk changed since load/save — saving needs an explicit decision. */
  conflict: boolean;
  /** Bumped on open/reload/external refresh: remount key for the WYSIWYG. */
  reloadToken: number;
  /** Internal: key of the in-flight open() — newer opens win (stale guard). */
  pendingOpen: string | null;
  error: MarkdownError | null;
  notice: string | null;
  mode: NoteMode;

  /* lifecycle */
  open: (projectId: string, path: string) => Promise<void>;
  /** Re-read from disk, discarding unsaved changes. */
  reload: () => Promise<void>;
  save: (opts?: { force?: boolean; silent?: boolean }) => Promise<boolean>;
  /** Focus-triggered external-change detection (TZ §6.5). */
  recheckExternal: () => Promise<void>;
  /** Save if dirty (best effort, into its OWN project), then drop. */
  flushAndReset: () => Promise<void>;
  reset: () => void;

  /* editing */
  setContent: (content: string) => void;
  setMode: (mode: NoteMode) => void;

  dismissNotice: () => void;
  clearError: () => void;
}

function toError(err: unknown): MarkdownError {
  if (err instanceof ApiError) return { code: err.code, message: err.message, hint: err.hint };
  return { code: "unknown_error", message: err instanceof Error ? err.message : String(err) };
}

/** mtime floats survive the JSON round-trip exactly; epsilon for safety. */
function mtimeDiffers(disk: number, saved: number | null): boolean {
  if (saved === null) return false;
  return Math.abs(disk - saved) > 1e-6;
}

export const useMarkdownStore = create<MarkdownState>()((set, get) => ({
  doc: null,
  dirty: false,
  saving: false,
  loading: false,
  conflict: false,
  reloadToken: 0,
  pendingOpen: null,
  error: null,
  notice: null,
  mode: "wysiwyg",

  open: async (projectId, path) => {
    const openKey = `${projectId}\u0000${path}`;
    set({ loading: true, error: null, conflict: false, notice: null, pendingOpen: openKey });
    try {
      const file = await workspaceApi.getFile(projectId, path);
      // Ignore stale responses: the project or the selected file may have
      // changed while the request was in flight.
      if ((useProjectStore.getState().current?.id ?? null) !== projectId) return;
      if (get().pendingOpen !== openKey) return; // a newer open() won
      set((state) => ({
        doc: {
          path,
          projectId,
          content: file.content,
          savedContent: file.content,
          savedMtime: file.mtime,
        },
        dirty: false,
        loading: false,
        conflict: false,
        mode: "wysiwyg",
        reloadToken: state.reloadToken + 1,
      }));
    } catch (err) {
      if (get().pendingOpen !== openKey) return;
      set({ loading: false, doc: null, error: toError(err) });
    }
  },

  reload: async () => {
    const doc = get().doc;
    if (!doc) return;
    set({ loading: true, error: null });
    try {
      const file = await workspaceApi.getFile(doc.projectId, doc.path);
      if (get().doc?.path !== doc.path) return;
      set((state) => ({
        doc: {
          ...doc,
          content: file.content,
          savedContent: file.content,
          savedMtime: file.mtime,
        },
        dirty: false,
        loading: false,
        conflict: false,
        reloadToken: state.reloadToken + 1,
        notice: `Перезагружено с диска: ${doc.path}`,
      }));
    } catch (err) {
      set({ loading: false, error: toError(err) });
    }
  },

  save: async (opts) => {
    const doc = get().doc;
    if (!doc) return false;
    set({ saving: true, error: null });
    const content = doc.content;
    try {
      const result = await workspaceApi.save(doc.projectId, {
        path: doc.path,
        content,
        base_mtime: opts?.force ? null : doc.savedMtime,
        force: opts?.force ?? false,
      });
      const now = get();
      set({ saving: false });
      // The document may have been switched while the save was in flight:
      // the response belongs to the OLD path — do not touch the new doc.
      if (now.doc?.path !== doc.path || now.doc.projectId !== doc.projectId) return true;
      set({
        doc: { ...now.doc, savedContent: content, savedMtime: result.mtime },
        dirty: now.doc.content !== content,
        conflict: false,
        notice: opts?.silent ? get().notice : `Сохранено: ${doc.path}`,
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

  recheckExternal: async () => {
    const doc = get().doc;
    if (!doc || get().loading) return;
    try {
      const file = await workspaceApi.getFile(doc.projectId, doc.path);
      if (get().doc?.path !== doc.path) return;
      if (!mtimeDiffers(file.mtime, doc.savedMtime) && file.content === doc.savedContent) return;
      if (get().dirty) {
        // Local edits exist — never overwrite them silently; the save flow
        // will offer the explicit reload/overwrite decision.
        set({ conflict: true });
        return;
      }
      set((state) => ({
        doc: {
          ...doc,
          content: file.content,
          savedContent: file.content,
          savedMtime: file.mtime,
        },
        reloadToken: state.reloadToken + 1,
        notice: `Файл изменён на диске — содержимое обновлено: ${doc.path}`,
      }));
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.code === "backend_unreachable") return; // do not nag on focus
      if (get().doc?.path !== doc.path) return;
      set({
        error: {
          code: apiError?.code ?? "note_recheck_failed",
          message:
            apiError?.code === "workspace_not_found"
              ? `Файл удалён или перемещён вне приложения: ${doc.path}`
              : `Не удалось проверить файл на диске: ${apiError?.message ?? String(err)}`,
          hint: apiError?.hint,
        },
      });
    }
  },

  flushAndReset: async () => {
    const { doc, dirty, save } = get();
    if (doc && dirty) {
      // Best effort: the note belongs to `doc.projectId`, not the new project.
      await save({ silent: true }).catch(() => undefined);
    }
    get().reset();
  },

  reset: () => {
    set({
      doc: null,
      dirty: false,
      saving: false,
      loading: false,
      conflict: false,
      pendingOpen: null,
      error: null,
      notice: null,
      mode: "wysiwyg",
    });
  },

  setContent: (content) => {
    const doc = get().doc;
    if (!doc || content === doc.content) return;
    set({ doc: { ...doc, content }, dirty: content !== doc.savedContent });
  },

  setMode: (mode) => set({ mode }),

  dismissNotice: () => set({ notice: null }),
  clearError: () => set({ error: null }),
}));
