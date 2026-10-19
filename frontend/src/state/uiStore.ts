/**
 * UI state store (zustand is the single state manager).
 *
 * backend connection + diagnostics.
 * active section switching.
 * space / experiments / diagnostics (experiment state lives in
 * experimentStore, space view state in spaceStore). The separate CORPUS
 * section was removed by user feedback: the corpus panel and the source
 * inspector live inside SPACE.
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type { HealthResponse } from "../api/types";

export type ConnectionStatus = "idle" | "loading" | "online" | "offline";
/** CORPUS was removed as a separate tab (user feedback): everything it
 *  showed lives in the SPACE section (corpus panel left, inspector right). */
export type ActiveSection = "space" | "relations" | "diagnostics" | "experiments" | "research";

export interface UiError {
  code: string;
  message: string;
  hint?: string;
}

interface UiState {
  connection: ConnectionStatus;
  health: HealthResponse | null;
  error: UiError | null;
  lastCheckedAt: number | null;
  activeSection: ActiveSection;
  setActiveSection: (section: ActiveSection) => void;
  /** Right-hand source inspector pane visibility (close button in its header). */
  inspectorVisible: boolean;
  setInspectorVisible: (visible: boolean) => void;
  /**
   * Fetch backend health. Background polls call it without options;
   * a user-initiated retry passes `{ interactive: true }` so the loading
   * state is shown even when a previous attempt failed.
 */
  refreshHealth: (opts?: { interactive?: boolean }) => Promise<void>;
}

export const useUiStore = create<UiState>()((set, get) => ({
  connection: "idle",
  health: null,
  error: null,
  lastCheckedAt: null,
  activeSection: "space",
  inspectorVisible: true,

  setActiveSection: (section) => set({ activeSection: section }),
  setInspectorVisible: (visible) => set({ inspectorVisible: visible }),

  refreshHealth: async (opts) => {
    // Show the loading state on the first fetch or on an explicit user retry;
    // background polls keep the current status to avoid flicker and
    // loading/offline oscillation (regression-tested in App.test.tsx).
    const { connection, health } = get();
    if (health === null && (connection === "idle" || opts?.interactive === true)) {
      set({ connection: "loading", error: null });
    }
    try {
      const health = await api.getHealth();
      set({ connection: "online", health, error: null, lastCheckedAt: Date.now() });
    } catch (err) {
      const apiError =
        err instanceof ApiError
          ? err
          : new ApiError(0, "unknown_error", err instanceof Error ? err.message : String(err));
      set({
        connection: "offline",
        health: null,
        error: { code: apiError.code, message: apiError.message, hint: apiError.hint },
        lastCheckedAt: Date.now(),
      });
    }
  },
}));
