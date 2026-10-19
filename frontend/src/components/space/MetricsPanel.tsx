import { useEffect, useMemo, useState } from "react";

import { exportUrls } from "../../api/client";
import { downloadFromApi } from "../../api/download";
import { formatMetricValue, metricLabel, orderedMetricIds } from "../../space/metricLabels";
import { runOptionLabel } from "../../space/projectionLabels";
import { useAnalysisStore } from "../../state/analysisStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";
import { JobProgress } from "../corpus/JobProgress";

/**
 * Metrics panel: compact numeric blocks, SECONDARY to
 * the space — collapsed by default, never occupies the screen permanently.
 *
 * Honesty rules:
 * - every value is shown with its explanation, k/sample/seed and the run it
 *   belongs to (a number without parameters is forbidden);
 * - null values render as «нет данных» (unknown ≠ zero);
 * - stale runs are badged, never served as fresh;
 * - the relation metrics carry the corpus-incompleteness caveat.
 */

export function MetricsPanel() {
  const current = useProjectStore((s) => s.current);
  const projections = useExperimentStore((s) => s.projections);
  const runs = useExperimentStore((s) => s.runs);
  const cloud3d = useSpaceStore((s) => s.cloud3d);
  const clouds2d = useSpaceStore((s) => s.clouds2d);
  const cloud4d = useSpaceStore((s) => s.cloud4d);

  const metricRuns = useAnalysisStore((s) => s.metricRuns);
  const metricsForm = useAnalysisStore((s) => s.metricsForm);
  const activeJob = useAnalysisStore((s) => s.activeJob);
  const error = useAnalysisStore((s) => s.error);
  const loadMetricRuns = useAnalysisStore((s) => s.loadMetricRuns);
  const setMetricsForm = useAnalysisStore((s) => s.setMetricsForm);
  const startMetrics = useAnalysisStore((s) => s.startMetrics);
  const deleteMetricRun = useAnalysisStore((s) => s.deleteMetricRun);
  const tickActiveJob = useAnalysisStore((s) => s.tickActiveJob);
  const cancelActiveJob = useAnalysisStore((s) => s.cancelActiveJob);

  const [expanded, setExpanded] = useState(false);
  const [projectionId, setProjectionId] = useState<string>("");
  const [selectedRunId, setSelectedRunId] = useState<string>("");

  useEffect(() => {
    if (!current || !expanded) return;
    void loadMetricRuns();
  }, [current, expanded, loadMetricRuns]);

  // Default projection: the one the views currently show (3D → 2D → 4D).
  const viewProjectionId =
    cloud3d?.projection.id ?? clouds2d[0]?.projection.id ?? cloud4d?.projection.id ?? "";
  useEffect(() => {
    setProjectionId((prev) => prev || viewProjectionId);
  }, [viewProjectionId]);

  const usableProjections = useMemo(
    () => (projections ?? []).filter((p) => p.cache_ok),
    [projections],
  );

  const jobRunning = activeJob?.state === "queued" || activeJob?.state === "running";
  useEffect(() => {
    if (!jobRunning || activeJob?.kind !== "metrics") return;
    const timer = window.setInterval(() => void tickActiveJob(), 1000);
    return () => window.clearInterval(timer);
  }, [jobRunning, activeJob?.kind, tickActiveJob]);

  const selectedProjection = usableProjections.find((p) => p.id === projectionId) ?? null;
  const embeddingRunId =
    selectedProjection?.embedding_run_id ?? runs?.[0]?.id ?? null;

  const shownRun =
    (metricRuns ?? []).find((r) => r.id === selectedRunId) ?? (metricRuns ?? [])[0] ?? null;

  const canCompute = embeddingRunId !== null && !jobRunning;

  return (
    <div className="metrics-panel" aria-label="Метрики качества">
      <div className="metrics-panel__row">
        <button
          type="button"
          className="metrics-panel__toggle btn btn--small"
          onClick={() => setExpanded((v) => !v)}
          aria-pressed={expanded}
          title="Метрики качества проекций и согласие соседей с известными структурными связями"
        >
          {expanded ? "▤" : "▢"} Метрики
        </button>

        {expanded && (
          <>
            <label className="metrics-panel__field">
              <span>проекция</span>
              <select
                className="proj-controls__select mono"
                value={projectionId}
                aria-label="Проекция для метрик"
                onChange={(e) => setProjectionId(e.target.value)}
              >
                <option value="">— без проекции (только связи) —</option>
                {usableProjections.map((p) => (
                  <option key={p.id} value={p.id}>
                    {runOptionLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="metrics-panel__field">
              <span>k</span>
              <input
                type="number"
                className="proj-controls__input mono metrics-panel__num"
                min={1}
                max={100}
                value={metricsForm.k}
                aria-label="Число соседей k"
                onChange={(e) => setMetricsForm({ k: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
            <label className="metrics-panel__field">
              <span>выборка</span>
              <input
                type="number"
                className="proj-controls__input mono metrics-panel__num"
                min={3}
                max={100000}
                value={metricsForm.sample}
                aria-label="Размер выборки"
                onChange={(e) =>
                  setMetricsForm({ sample: Math.max(3, Number(e.target.value) || 3) })
                }
              />
            </label>
            <label className="metrics-panel__field">
              <span>seed</span>
              <input
                type="number"
                className="proj-controls__input mono metrics-panel__num"
                min={0}
                value={metricsForm.seed}
                aria-label="Зерно случайности выборки"
                onChange={(e) =>
                  setMetricsForm({ seed: Math.max(0, Number(e.target.value) || 0) })
                }
              />
            </label>
            <button
              type="button"
              className="btn btn--small"
              disabled={!canCompute}
              title={
                embeddingRunId
                  ? "Посчитать метрики (детерминированная выборка; результат сохранится с параметрами)"
                  : "Сначала вычислите эмбеддинги (EXPERIMENTS)"
              }
              onClick={() => {
                if (!embeddingRunId) return;
                setSelectedRunId("");
                void startMetrics({
                  embedding_run_id: embeddingRunId,
                  projection_run_id: selectedProjection?.id ?? null,
                  k: metricsForm.k,
                  sample: metricsForm.sample,
                  seed: metricsForm.seed,
                });
              }}
            >
              Посчитать
            </button>
          </>
        )}
      </div>

      {expanded && (
        <div className="metrics-panel__body">
          {activeJob?.kind === "metrics" && (
            <JobProgress
              job={activeJob}
              runningLabel="метрики"
              onCancel={() => void cancelActiveJob()}
            />
          )}
          {error && (
            <div className="workspace-error" role="alert">
              <span>{error.message}</span>
              {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
            </div>
          )}

          {metricRuns !== null && metricRuns.length > 1 && (
            <label className="metrics-panel__field">
              <span>запуск</span>
              <select
                className="proj-controls__select mono"
                value={shownRun?.id ?? ""}
                aria-label="Запуск метрик"
                onChange={(e) => setSelectedRunId(e.target.value)}
              >
                {(metricRuns ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.updated_at).toLocaleString("ru-RU")} · k={r.k} · выборка{" "}
                    {r.sample_size}
                    {r.projection_run_id ? ` · ${r.projection_run_id.slice(0, 6)}` : " · связи"}
                    {r.stale ? " · УСТАРЕЛ" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          {shownRun && (
            <div className="metrics-panel__result" data-testid="metrics-result">
              <div className="metrics-panel__belongs">
                {(() => {
                  if (!shownRun.projection_run_id) return "без проекции — только структурные связи";
                  const shownProjection = usableProjections.find(
                    (p) => p.id === shownRun.projection_run_id,
                  );
                  return shownProjection
                    ? runOptionLabel(shownProjection)
                    : `проекция ${shownRun.projection_run_id.slice(0, 6)} (удалена из инвентаря)`;
                })()}{" "}
                · векторов: {shownRun.n_vectors} · k={shownRun.k}, выборка{" "}
                {shownRun.sample_size}, seed {shownRun.seed}
                {shownRun.stale && <span className="badge badge--warn"> устарел</span>}
              </div>

              <div className="metrics-panel__blocks">
                {orderedMetricIds(Object.keys(shownRun.metrics)).map((id) => {
                  const metric = shownRun.metrics[id];
                  return (
                    <details key={id} className="metric-block">
                      <summary className="metric-block__summary">
                        <span className="metric-block__label">{metricLabel(id)}</span>
                        <span className="metric-block__value mono">
                          {formatMetricValue(metric.value)}
                        </span>
                        {metric.k !== null && (
                          <span className="metric-block__k mono">k={metric.k}</span>
                        )}
                      </summary>
                      <div className="metric-block__explain">{metric.explanation}</div>
                      <div className="metric-block__counts mono">
                        {metric.n_sampled !== null && <>точек в выборке: {metric.n_sampled}; </>}
                        {metric.n_sampled_with_relations !== null && (
                          <>с известными связями: {metric.n_sampled_with_relations}; </>
                        )}
                        {metric.n_known_pairs_embedded !== null && (
                          <>известных пар с векторами: {metric.n_known_pairs_embedded}; </>
                        )}
                        {metric.n_pairs_considered !== null && (
                          <>пар учтено: {metric.n_pairs_considered}; </>
                        )}
                        запуск {shownRun.id.slice(0, 8)}
                      </div>
                    </details>
                  );
                })}
              </div>

              {shownRun.warnings.length > 0 && (
                <ul className="metrics-panel__warnings" aria-label="Предупреждения метрик">
                  {shownRun.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}

              <div className="metrics-panel__actions">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => {
                    if (!current) return;
                    void downloadFromApi(
                      exportUrls.metricRun(current.id, shownRun.id),
                      `metrics_${shownRun.id}.json`,
                    );
                  }}
                  title="Скачать JSON со значениями, пояснениями, параметрами и версиями библиотек"
                >
                  Экспорт JSON
                </button>
                <button
                  type="button"
                  className="btn btn--small btn--danger"
                  onClick={() => {
                    setSelectedRunId("");
                    void deleteMetricRun(shownRun.id);
                  }}
                >
                  Удалить запуск
                </button>
              </div>
            </div>
          )}

          {metricRuns !== null && metricRuns.length === 0 && !jobRunning && (
            <p className="empty-hint">
              Запусков метрик пока нет. Метрики проекций считаются по ИСХОДНЫМ векторам и
              координатам проекции; метрики связей — по известным структурным связям
              (вкладка RELATIONS). Отсутствие известной связи не считается доказательством
              отсутствия связи.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
