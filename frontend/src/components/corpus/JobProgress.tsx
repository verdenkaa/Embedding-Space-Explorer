import { useEffect, useState } from "react";

import { useProjectStore } from "../../state/projectStore";

/** Polls the active background job while it runs (TZ §10: polling). */
const POLL_INTERVAL_MS = 1000;

export function JobPoller() {
  const activeJob = useProjectStore((s) => s.activeJob);
  const tickActiveJob = useProjectStore((s) => s.tickActiveJob);
  const running = activeJob?.state === "queued" || activeJob?.state === "running";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void tickActiveJob(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, tickActiveJob]);

  return null;
}

export function JobProgress() {
  const activeJob = useProjectStore((s) => s.activeJob);
  const cancelActiveJob = useProjectStore((s) => s.cancelActiveJob);
  const [warningsOpen, setWarningsOpen] = useState(false);

  if (!activeJob) return null;
  const { state, progress_done, progress_total, message, error, warnings } = activeJob;
  const running = state === "queued" || state === "running";
  const pct = progress_total > 0 ? Math.round((progress_done / progress_total) * 100) : 0;

  return (
    <div className={`job-progress job-progress--${state}`} role="status">
      <div className="job-progress__line">
        {running && <span className="spinner" aria-hidden="true" />}
        <span className="job-progress__state">
          {state === "queued" && "в очереди"}
          {state === "running" && `индексирование ${progress_done}/${progress_total}`}
          {state === "done" && "готово"}
          {state === "failed" && "ошибка"}
          {state === "cancelled" && "отменено"}
        </span>
        {running && (
          <span className="job-progress__bar" aria-hidden="true">
            <span className="job-progress__fill" style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className="job-progress__message mono" title={message ?? undefined}>
          {running ? message : state === "done" ? message : null}
        </span>
        {running && (
          <button
            type="button"
            className="btn btn--small btn--danger"
            onClick={() => void cancelActiveJob()}
          >
            Отменить
          </button>
        )}
        {warnings.length > 0 && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setWarningsOpen((v) => !v)}
            title="Показать предупреждения индексирования"
            aria-expanded={warningsOpen}
          >
            ⚠ {warnings.length}
          </button>
        )}
      </div>
      {state === "failed" && error && <div className="job-progress__error">{error}</div>}
      {warningsOpen && warnings.length > 0 && (
        <ul className="job-progress__warnings">
          {warnings.slice(0, 100).map((w, i) => (
            <li key={i} className="mono">
              {w}
            </li>
          ))}
          {warnings.length > 100 && <li>…и ещё {warnings.length - 100}</li>}
        </ul>
      )}
    </div>
  );
}
