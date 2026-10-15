import { useEffect } from "react";

import { useExperimentStore } from "../state/experimentStore";
import { useProjectStore } from "../state/projectStore";
import { JobProgress } from "./corpus/JobProgress";

const JOB_POLL_MS = 1000;

/**
 * EXPERIMENTS section: embedding model, text-preparation mode, compute runs
 * and coverage. Projections live in the SPACE section (stage 3);
 * neighbors/clusters/metrics arrive at stages 4–5 — stated honestly, no
 * fake controls (TZ §17.2).
 */
export function ExperimentsPanel() {
  const current = useProjectStore((s) => s.current);
  const models = useExperimentStore((s) => s.models);
  const previews = useExperimentStore((s) => s.previews);
  const runs = useExperimentStore((s) => s.runs);
  const activeJob = useExperimentStore((s) => s.activeJob);
  const modelId = useExperimentStore((s) => s.modelId);
  const mode = useExperimentStore((s) => s.mode);
  const batchSize = useExperimentStore((s) => s.batchSize);
  const error = useExperimentStore((s) => s.error);
  const loadCatalog = useExperimentStore((s) => s.loadCatalog);
  const loadRuns = useExperimentStore((s) => s.loadRuns);
  const setModelId = useExperimentStore((s) => s.setModelId);
  const setMode = useExperimentStore((s) => s.setMode);
  const setBatchSize = useExperimentStore((s) => s.setBatchSize);
  const startDownload = useExperimentStore((s) => s.startDownload);
  const startCompute = useExperimentStore((s) => s.startCompute);
  const tickActiveJob = useExperimentStore((s) => s.tickActiveJob);
  const cancelActiveJob = useExperimentStore((s) => s.cancelActiveJob);

  useEffect(() => {
    if (!current) return;
    void loadCatalog();
    void loadRuns();
  }, [current, loadCatalog, loadRuns]);

  // Poll the embedding/download job while it runs.
  const running = activeJob?.state === "queued" || activeJob?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void tickActiveJob(), JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [running, tickActiveJob]);

  if (!current) {
    return (
      <div className="experiments">
        <div className="empty-hint">Откройте проект, чтобы работать с эмбеддингами.</div>
      </div>
    );
  }

  const selectedModel = models?.find((m) => m.model_id === modelId) ?? null;
  const jobRunning = Boolean(running);

  return (
    <div className="experiments">
      <div className="diagnostics__header">
        <h1 className="diagnostics__title">Эксперименты: эмбеддинги и запуски</h1>
        <p className="diagnostics__subtitle">
          Модель, режим подготовки текста и расчёт векторов. Проекции строятся и
          исследуются в разделе SPACE; соседи, кластеры и метрики появятся на этапах 4–5.
        </p>
      </div>

      {error && (
        <div className="workspace-error" role="alert">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
        </div>
      )}

      <JobProgress
        job={activeJob}
        onCancel={() => void cancelActiveJob()}
        runningLabel={activeJob?.kind === "model_download" ? "скачивание модели" : "эмбеддинги"}
      />

      {/* 1. Model */}
      <section className="panel-card" aria-labelledby="model-title">
        <h2 className="panel-card__title" id="model-title">
          1 · Модель
        </h2>
        {models === null && <p className="empty-hint">Загрузка каталога…</p>}
        <div className="model-list" role="radiogroup" aria-label="Embedding-модели">
          {(models ?? []).map((model) => (
            <label
              key={model.model_id}
              className={`model-card${model.model_id === modelId ? " model-card--selected" : ""}`}
            >
              <input
                type="radio"
                name="embedding-model"
                checked={model.model_id === modelId}
                onChange={() => setModelId(model.model_id)}
                disabled={jobRunning}
              />
              <span className="model-card__body">
                <span className="model-card__name mono">
                  {model.display_name}
                  {model.is_default && <span className="badge"> по умолчанию</span>}
                </span>
                <span className="model-card__meta mono">
                  {model.dim} измерений · ~{model.approx_download_mb} МБ ·{" "}
                  {model.downloaded ? (
                    <span className="model-card__downloaded">✓ скачана</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={jobRunning}
                      onClick={(e) => {
                        e.preventDefault();
                        void startDownload(model.model_id);
                      }}
                      title="Первое скачивание требует сеть; после — модель работает офлайн"
                    >
                      Скачать (~{model.approx_download_mb} МБ)
                    </button>
                  )}
                </span>
                <span className="model-card__desc">{model.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* 2. Text preparation */}
      <section className="panel-card" aria-labelledby="prep-title">
        <h2 className="panel-card__title" id="prep-title">
          2 · Подготовка текста
        </h2>
        <div className="prep-modes" role="radiogroup" aria-label="Режим подготовки текста">
          <label className="prep-mode">
            <input
              type="radio"
              name="prep-mode"
              checked={mode === "raw_fragment"}
              onChange={() => setMode("raw_fragment")}
              disabled={jobRunning}
            />
            <span>
              <b>Raw fragment</b> — только текст фрагмента
            </span>
          </label>
          <label className="prep-mode">
            <input
              type="radio"
              name="prep-mode"
              checked={mode === "context_enriched"}
              onChange={() => setMode("context_enriched")}
              disabled={jobRunning}
            />
            <span>
              <b>Context-enriched</b> — текст + явный контекст (путь, символ, тип, родитель)
            </span>
          </label>
        </div>
        {previews && (
          <details className="prep-preview">
            <summary>Точный шаблон того, что будет эмбеддиться</summary>
            <pre className="state-block__code prep-preview__text">
              {previews[mode]}
            </pre>
          </details>
        )}
        <p className="prep-note">
          Режимы не смешиваются: каждый запуск хранит свои векторы и параметры
          (модель, шаблон, batch size). Сравнение режимов = два запуска.
        </p>
      </section>

      {/* 3. Compute */}
      <section className="panel-card" aria-labelledby="compute-title">
        <h2 className="panel-card__title" id="compute-title">
          3 · Расчёт
        </h2>
        <div className="compute-row">
          <label className="compute-row__field">
            <span>batch size</span>
            <input
              type="number"
              className="create-form__input create-form__input--num mono"
              min={1}
              max={128}
              value={batchSize}
              disabled={jobRunning}
              onChange={(e) => setBatchSize(Number.parseInt(e.target.value, 10) || 1)}
              title="Консервативное значение для машин с 8 ГБ RAM; при нехватке памяти уменьшайте"
            />
          </label>
          <button
            type="button"
            className="btn btn--primary"
            disabled={jobRunning || !selectedModel}
            onClick={() => void startCompute()}
            title={
              selectedModel?.downloaded
                ? "Посчитать недостающие векторы (закэшированные не пересчитываются)"
                : "Сначала скачайте модель"
            }
          >
            Рассчитать эмбеддинги
          </button>
          {!selectedModel?.downloaded && selectedModel && (
            <span className="compute-row__hint">модель не скачана</span>
          )}
        </div>
        <p className="prep-note">
          Отмена между батчами сохраняет уже посчитанные векторы; повторный запуск
          продолжает с места остановки. Изменившиеся фрагменты пересчитываются,
          удалённые — убираются из кэша автоматически.
        </p>
      </section>

      {/* Runs inventory */}
      <section className="panel-card" aria-labelledby="runs-title">
        <h2 className="panel-card__title" id="runs-title">
          Запуски (векторные кэши)
        </h2>
        {runs === null && <p className="empty-hint">Загрузка…</p>}
        {runs !== null && runs.length === 0 && (
          <p className="empty-hint">
            Запусков ещё нет. Выберите модель и нажмите «Рассчитать эмбеддинги».
          </p>
        )}
        {runs !== null && runs.length > 0 && (
          <table className="deps-table runs-table">
            <thead>
              <tr>
                <th scope="col">Модель</th>
                <th scope="col">Режим</th>
                <th scope="col">Dim</th>
                <th scope="col">Покрытие</th>
                <th scope="col">Обновлён</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const cov = run.coverage;
                const full = cov.missing === 0 && cov.stale === 0;
                return (
                  <tr key={run.id}>
                    <td className="mono" title={run.model_id}>
                      {run.model_display_name}
                    </td>
                    <td>
                      <span className="badge" title={run.template_preview}>
                        {run.mode}
                      </span>
                    </td>
                    <td className="mono">{run.dim}</td>
                    <td className="mono">
                      {cov.embedded}/{cov.fragments_total}
                      {!full && (
                        <span className="runs-table__gap">
                          {" "}
                          (пропущено {cov.missing}, устарело {cov.stale})
                        </span>
                      )}
                    </td>
                    <td className="mono">{run.updated_at}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={jobRunning}
                        onClick={() => {
                          setModelId(run.model_id);
                          setMode(run.mode);
                          void startCompute();
                        }}
                        title="Досчитать недостающие/устаревшие векторы этого запуска"
                      >
                        Пересчитать
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
