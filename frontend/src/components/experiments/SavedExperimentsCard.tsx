import { useEffect, useState } from "react";

import { exportUrls } from "../../api/client";
import { downloadFromApi } from "../../api/download";
import type { ExperimentDTO } from "../../api/types";
import { buildComparisonRows, formatExperimentSummary } from "../../experiments/summary";
import { useProjectStore } from "../../state/projectStore";
import { useSavedExperimentsStore } from "../../state/savedExperimentsStore";

/**
 * Saved experiments card (stage 5, TZ §9.2): save the current SPACE state as
 * a named reopenable snapshot; open restores what is still alive and REPORTS
 * everything that is not (deleted/stale references are never silently
 * substituted); compare puts two snapshots side by side (configs + save-time
 * context + captured metric values).
 */
export function SavedExperimentsCard() {
  const current = useProjectStore((s) => s.current);
  const experiments = useSavedExperimentsStore((s) => s.experiments);
  const loading = useSavedExperimentsStore((s) => s.loading);
  const error = useSavedExperimentsStore((s) => s.error);
  const lastOpenReport = useSavedExperimentsStore((s) => s.lastOpenReport);
  const loadExperiments = useSavedExperimentsStore((s) => s.loadExperiments);
  const saveExperiment = useSavedExperimentsStore((s) => s.saveExperiment);
  const openExperiment = useSavedExperimentsStore((s) => s.openExperiment);
  const deleteExperiment = useSavedExperimentsStore((s) => s.deleteExperiment);
  const fetchDetail = useSavedExperimentsStore((s) => s.fetchDetail);
  const clearOpenReport = useSavedExperimentsStore((s) => s.clearOpenReport);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{ a: ExperimentDTO; b: ExperimentDTO } | null>(
    null,
  );

  useEffect(() => {
    if (!current) return;
    void loadExperiments();
  }, [current, loadExperiments]);

  const toggleCompare = (id: string) => {
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2),
    );
  };

  const runCompare = async () => {
    if (compareIds.length !== 2) return;
    const [a, b] = await Promise.all([fetchDetail(compareIds[0]), fetchDetail(compareIds[1])]);
    if (a && b) setComparison({ a, b });
  };

  return (
    <section className="panel-card" aria-labelledby="saved-experiments-title">
      <h2 className="panel-card__title" id="saved-experiments-title">
        Эксперименты (сохранённые состояния)
      </h2>
      <p className="prep-note">
        Снимок текущего состояния SPACE: виды и проекции, срез, раскраска
        кластерами, группы, выделение и метрики — плюс контекст для
        интерпретации (корпус, версии, значения метрик на момент сохранения).
        При открытии отсутствующие объекты перечисляются честно, а не
        подменяются другими.
      </p>

      {error && (
        <div className="workspace-error" role="alert">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
        </div>
      )}

      <div className="saved-exp__form">
        <input
          className="create-form__input saved-exp__name"
          placeholder="Имя эксперимента"
          value={name}
          maxLength={128}
          aria-label="Имя эксперимента"
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="create-form__input saved-exp__desc"
          placeholder="Описание (необязательно)"
          value={description}
          maxLength={512}
          aria-label="Описание эксперимента"
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!name.trim() || loading}
          title="Сохранить виды, срез, раскраску, группы, выделение и метрики текущего SPACE"
          onClick={async () => {
            const ok = await saveExperiment(name, description);
            if (ok) {
              setName("");
              setDescription("");
            }
          }}
        >
          Сохранить текущее состояние
        </button>
      </div>

      {lastOpenReport && (
        <div className="saved-exp__report" role="status">
          <div className="saved-exp__report-head">
            <span>Отчёт открытия</span>
            <button type="button" className="btn btn--small" onClick={clearOpenReport}>
              ✕
            </button>
          </div>
          {lastOpenReport.applied.length > 0 && (
            <p>Восстановлено: {lastOpenReport.applied.join(", ")}.</p>
          )}
          {lastOpenReport.skipped.length > 0 && (
            <p className="saved-exp__report-skipped">
              Не восстановлено: {lastOpenReport.skipped.join("; ")}.
            </p>
          )}
        </div>
      )}

      {experiments === null && <p className="empty-hint">Загрузка…</p>}
      {experiments !== null && experiments.length === 0 && (
        <p className="empty-hint">
          Сохранённых экспериментов нет. Настройте виды в SPACE и нажмите
          «Сохранить текущее состояние».
        </p>
      )}

      {experiments !== null && experiments.length > 0 && (
        <table className="deps-table saved-exp__table">
          <thead>
            <tr>
              <th scope="col" aria-label="Отметить для сравнения" />
              <th scope="col">Имя</th>
              <th scope="col">Сохранён</th>
              <th scope="col">Содержимое</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {experiments.map((exp) => (
              <tr key={exp.id} className={compareIds.includes(exp.id) ? "saved-exp__row--cmp" : ""}>
                <td>
                  <input
                    type="checkbox"
                    checked={compareIds.includes(exp.id)}
                    aria-label={`Сравнить «${exp.name}»`}
                    onChange={() => toggleCompare(exp.id)}
                  />
                </td>
                <td>
                  <span className="saved-exp__name-cell">{exp.name}</span>
                  {exp.description && (
                    <span className="saved-exp__desc-cell">{exp.description}</span>
                  )}
                </td>
                <td className="mono">{exp.created_at.replace("T", " ").slice(0, 16)}</td>
                <td>
                  <div className="saved-exp__chips">
                    {formatExperimentSummary(exp.summary).map((chip) => (
                      <span key={chip} className="badge saved-exp__chip">
                        {chip}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <div className="saved-exp__actions">
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={loading}
                      title="Восстановить виды, срез, раскраску, группы и выделение (отсутствующее будет перечислено)"
                      onClick={() => void openExperiment(exp.id)}
                    >
                      Открыть
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      title="JSON: конфиг + снимок на момент сохранения + живой статус ссылок"
                      disabled={!current}
                      onClick={() => {
                        if (!current) return;
                        void downloadFromApi(
                          exportUrls.experiment(current.id, exp.id),
                          `experiment_${exp.name}.json`,
                        );
                      }}
                    >
                      Экспорт
                    </button>
                    {armedDelete === exp.id ? (
                      <span className="view-bar__confirm" role="group">
                        <button
                          type="button"
                          className="btn btn--small btn--danger"
                          onClick={() => {
                            setArmedDelete(null);
                            void deleteExperiment(exp.id);
                          }}
                        >
                          Удалить?
                        </button>
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() => setArmedDelete(null)}
                        >
                          Нет
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => setArmedDelete(exp.id)}
                      >
                        Удалить
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {experiments !== null && experiments.length > 1 && (
        <div className="saved-exp__compare-bar">
          <button
            type="button"
            className="btn btn--small"
            disabled={compareIds.length !== 2}
            onClick={() => void runCompare()}
            title="Отметьте два эксперимента флажками"
          >
            Сравнить отмеченные ({compareIds.length}/2)
          </button>
          {comparison && (
            <button type="button" className="btn btn--small" onClick={() => setComparison(null)}>
              Скрыть сравнение
            </button>
          )}
        </div>
      )}

      {comparison && (
        <table className="deps-table saved-exp__compare" aria-label="Сравнение экспериментов">
          <thead>
            <tr>
              <th scope="col">Параметр</th>
              <th scope="col">{comparison.a.name}</th>
              <th scope="col">{comparison.b.name}</th>
            </tr>
          </thead>
          <tbody>
            {buildComparisonRows(comparison.a, comparison.b).map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td className="mono">{row.a}</td>
                <td className="mono">{row.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
