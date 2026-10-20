import { useEffect, useState } from "react";

import type { NeighborMetric } from "../../api/types";
import { kindBadge } from "../../monaco/helpers";
import { neighborToRef } from "../../space/fragmentRef";
import { useAnalysisStore } from "../../state/analysisStore";
import { useProjectStore } from "../../state/projectStore";
import { JobProgress } from "../corpus/JobProgress";

/**
 * NEIGHBORS tab: semantic k-nearest neighbors of the ACTIVE
 * fragment, computed by the backend over the ORIGINAL embeddings (the note
 * says so explicitly — semantic proximity is never confused with structural
 * links or with distances on a projection map).
 */

export function AnalysisJobPoller() {
  const activeJob = useAnalysisStore((s) => s.activeJob);
  const tickActiveJob = useAnalysisStore((s) => s.tickActiveJob);
  const running = activeJob?.state === "queued" || activeJob?.state === "running";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void tickActiveJob(), 1000);
    return () => clearInterval(timer);
  }, [running, tickActiveJob]);

  return null;
}

export function NeighborsTab() {
  const activeFragmentId = useProjectStore((s) => s.activeFragmentId);
  const selectFragment = useProjectStore((s) => s.selectFragment);
  const neighbors = useAnalysisStore((s) => s.neighbors);
  const neighborsFor = useAnalysisStore((s) => s.neighborsFor);
  const loading = useAnalysisStore((s) => s.neighborsLoading);
  const loadNeighbors = useAnalysisStore((s) => s.loadNeighbors);
  const error = useAnalysisStore((s) => s.error);

  const [k, setK] = useState(10);
  const [metric, setMetric] = useState<NeighborMetric>("cosine");

  useEffect(() => {
    if (!activeFragmentId) return;
    void loadNeighbors(activeFragmentId, k, metric);
  }, [activeFragmentId, k, metric, loadNeighbors]);

  const current = neighbors && neighborsFor === activeFragmentId ? neighbors : null;

  return (
    <div className="analysis-pane" aria-label="Семантические соседи">
      <div className="analysis-pane__controls">
        <label className="analysis-pane__field">
          <span>k</span>
          <input
            type="number"
            className="proj-controls__input mono"
            min={1}
            max={50}
            value={k}
            aria-label="Число соседей k"
            onChange={(e) => {
              const value = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(value)) setK(Math.min(50, Math.max(1, value)));
            }}
          />
        </label>
        <label className="analysis-pane__field">
          <span>метрика</span>
          <select
            className="proj-controls__select mono"
            value={metric}
            aria-label="Метрика сходства"
            onChange={(e) => setMetric(e.target.value as NeighborMetric)}
          >
            <option value="cosine">cosine</option>
            <option value="euclidean">euclidean</option>
          </select>
        </label>
      </div>

      {error && (
        <div className="proj-controls__error" role="alert">
          {error.message}
          {error.hint && <span className="workspace-error__hint"> {error.hint}</span>}
        </div>
      )}

      {!activeFragmentId && (
        <div className="empty-hint">
          Выберите точку на сцене или фрагмент в списке — здесь появятся его
          ближайшие семантические соседи.
        </div>
      )}
      {activeFragmentId && loading && !current && (
        <div className="empty-hint" role="status">
          Поиск соседей…
        </div>
      )}
      {activeFragmentId && !loading && !current && !error && (
        <div className="empty-hint">
          Нет вектора для этого фрагмента в выбранном запуске — рассчитайте
          эмбеддинги (EXPERIMENTS).
        </div>
      )}

      {current && (
        <>
          <p className="analysis-pane__note">{current.note}</p>
          <ul className="neighbors-list">
            {current.neighbors.map((n, rank) => (
              <li key={n.fragment_id}>
                <button
                  type="button"
                  className="neighbors-list__item"
                  title={`${n.rel_path}:${n.start_line}–${n.end_line}`}
                  onClick={() => void selectFragment(neighborToRef(n))}
                >
                  <span className="neighbors-list__rank mono">{rank + 1}</span>
                  <span className="legend-item__badge mono">{kindBadge(n.kind)}</span>
                  <span className="neighbors-list__name">
                    {n.name ?? n.symbol_path}
                    <span className="neighbors-list__path mono">
                      {n.rel_path}:{n.start_line}–{n.end_line}
                    </span>
                  </span>
                  <span
                    className="neighbors-list__score mono"
                    title={
                      current.metric === "cosine"
                        ? `косинусное сходство ${n.score} (не процент; distance ${n.distance})`
                        : `distance ${n.distance}`
                    }
                  >
                    {/* cosine similarity is NOT a share: it can be negative and
                        lives in a narrow band for sentence models — the raw
                        value is honest, "62%" invented a scale (audit #16) */}
                    {current.metric === "cosine"
                      ? `${n.score.toFixed(3)} cos`
                      : n.distance.toFixed(3)}
                  </span>
                </button>
              </li>
            ))}
            {current.neighbors.length === 0 && (
              <li className="empty-hint">Соседей нет (в запуске меньше двух векторов).</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

/** Progress of jobs, shared by the tabs that start them. */
export function AnalysisJobProgress() {
  const activeJob = useAnalysisStore((s) => s.activeJob);
  const cancelActiveJob = useAnalysisStore((s) => s.cancelActiveJob);
  return (
    <JobProgress
      job={activeJob}
      onCancel={() => void cancelActiveJob()}
      runningLabel={activeJob?.kind === "clustering" ? "кластеризация" : "извлечение связей"}
    />
  );
}
