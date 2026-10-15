import { useEffect } from "react";

import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { StartScreen } from "./components/StartScreen";
import { StatusBar } from "./components/StatusBar";
import { TopBar } from "./components/TopBar";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { useProjectStore } from "./state/projectStore";
import { useUiStore } from "./state/uiStore";

/**
 * Health polling interval (TZ §10: polling, no WebSocket). Deliberately fixed:
 * scheduling must not depend on the connection state, otherwise a
 * state-change → effect → retry → state-change loop can starve the event loop
 * when the backend is down (regression-tested in App.test.tsx).
 */
const REFRESH_INTERVAL_MS = 5_000;

export default function App() {
  const refreshHealth = useUiStore((s) => s.refreshHealth);
  const activeSection = useUiStore((s) => s.activeSection);
  const current = useProjectStore((s) => s.current);

  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main">
        {activeSection === "diagnostics" ? (
          <DiagnosticsPanel />
        ) : current ? (
          <WorkspaceLayout />
        ) : (
          <StartScreen />
        )}
      </main>
      <StatusBar />
    </div>
  );
}
