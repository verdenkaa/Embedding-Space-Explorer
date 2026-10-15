/**
 * UI state store (zustand is the single state manager — TZ §2.2).
 *
 * Stage 0: backend connection + diagnostics.
 * Stage 1: active section switching.
 * Stage 3: corpus / space / experiments / diagnostics (experiment state
 * lives in experimentStore, space view state in spaceStore).
 */

import { create } from "zustand";

import { ApiError, api } from "../api/client";
import type { HealthResponse } from "../api/types";

export type ConnectionStatus = "idle" | "loading" | "online" | "offline";
export type ActiveSection = "corpus" | "space" | "diagnostics" | "experiments";

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
  activeSection: "corpus",

  setActiveSection: (section) => set({ activeSection: section }),

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
