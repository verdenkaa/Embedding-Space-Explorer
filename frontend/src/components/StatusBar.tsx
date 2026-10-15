import { useProjectStore } from "../state/projectStore";
import { useUiStore } from "../state/uiStore";

function formatTime(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts).toLocaleTimeString("ru-RU", { hour12: false });
}

/** Bottom status line: project stats, job state, connection, versions. */
export function StatusBar() {
  const connection = useUiStore((s) => s.connection);
  const health = useUiStore((s) => s.health);
  const lastCheckedAt = useUiStore((s) => s.lastCheckedAt);
  const current = useProjectStore((s) => s.current);
  const activeJob = useProjectStore((s) => s.activeJob);

  const stats = current?.stats;

  return (
    <footer className="statusbar">
      <span className="statusbar__segment">
        проект: {current ? current.name : "—"}
      </span>
      {stats && (
        <span className="statusbar__segment">
          файлов: {stats.files_indexed}
          {stats.files_error > 0 ? ` (ошибок: ${stats.files_error})` : ""} · фрагментов:{" "}
          {stats.fragments}
        </span>
      )}
      {activeJob && (
        <span
          className={`statusbar__segment statusbar__segment--job-${activeJob.state}`}
          title={activeJob.message ?? undefined}
        >
          задача: {activeJob.kind} — {activeJob.state}
          {activeJob.state === "running" &&
            ` ${activeJob.progress_done}/${activeJob.progress_total}`}
        </span>
      )}
      <span className="statusbar__spacer" />
      <span className="statusbar__segment">
        backend:{" "}
        {connection === "online" ? "подключен" : connection === "offline" ? "недоступен" : "…"}
      </span>
      {health && <span className="statusbar__segment">python {health.python_version}</span>}
      <span className="statusbar__segment">проверка: {formatTime(lastCheckedAt)}</span>
      <span className="statusbar__segment">
        {health ? `v${health.app_version}` : "v—"} · этап 1
      </span>
    </footer>
  );
}
