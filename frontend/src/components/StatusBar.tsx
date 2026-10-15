import { useUiStore } from "../state/uiStore";

function formatTime(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

/** Bottom status line: connection, runtime, data dir, app version (UI-ТЗ §1). */
export function StatusBar() {
  const connection = useUiStore((s) => s.connection);
  const health = useUiStore((s) => s.health);
  const lastCheckedAt = useUiStore((s) => s.lastCheckedAt);

  return (
    <footer className="statusbar">
      <span className="statusbar__segment">
        backend: {connection === "online" ? "подключен" : connection === "offline" ? "недоступен" : "…"}
      </span>
      {health && (
        <>
          <span className="statusbar__segment">python {health.python_version}</span>
          <span className="statusbar__segment" title={health.data_dir}>
            данные: {health.data_dir}
          </span>
        </>
      )}
      <span className="statusbar__spacer" />
      <span className="statusbar__segment">проверка: {formatTime(lastCheckedAt)}</span>
      <span className="statusbar__segment">
        {health ? `v${health.app_version}` : "v—"} · этап 0
      </span>
    </footer>
  );
}
