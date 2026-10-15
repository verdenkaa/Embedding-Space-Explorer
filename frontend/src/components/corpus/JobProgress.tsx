import { useEffect, useState } from "react";

import type { JobInfo } from "../../api/types";
import { useProjectStore } from "../../state/projectStore";

/** Polls the corpus (index) job while it runs (TZ §10: polling). */
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

interface JobProgressProps {
  job: JobInfo | null;
  onCancel?: () => void;
  /** Prefix for the running label, e.g. "индексирование" or "эмбеддинги". */
  runningLabel?: string;
}

/** Presentational job progress line with cancel and warnings (shared). */
export function JobProgress({ job, onCancel, runningLabel = "индексирование" }: JobProgressProps) {
  const [warningsOpen, setWarningsOpen] = useState(false);

  if (!job) return null;
  const { state, progress_done, progress_total, message, error, warnings } = job;
  const running = state === "queued" || state === "running";
  const pct = progress_total > 0 ? Math.round((progress_done / progress_total) * 100) : 0;

  return (
    <div className={`job-progress job-progress--${state}`} role="status">
      <div className="job-progress__line">
        {running && <span className="spinner" aria-hidden="true" />}
        <span className="job-progress__state">
          {state === "queued" && "в очереди"}
          {state === "running" &&
            (progress_total > 0 ? `${runningLabel} ${progress_done}/${progress_total}` : runningLabel)}
          {state === "done" && "готово"}
          {state === "failed" && "ошибка"}
          {state === "cancelled" && "отменено"}
        </span>
        {running && progress_total > 0 && (
          <span className="job-progress__bar" aria-hidden="true">
            <span className="job-progress__fill" style={{ width: `${pct}%` }} />
          </span>
        )}
        <span className="job-progress__message mono" title={message ?? undefined}>
          {message}
        </span>
        {running && onCancel && (
          <button type="button" className="btn btn--small btn--danger" onClick={onCancel}>
            Отменить
          </button>
        )}
        {warnings.length > 0 && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setWarningsOpen((v) => !v)}
            title="Показать предупреждения"
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
