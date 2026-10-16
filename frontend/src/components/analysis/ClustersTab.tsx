import { useEffect, useState } from "react";

import type { ClusteringSpace } from "../../api/types";
import { useAnalysisStore } from "../../state/analysisStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";
import { AnalysisJobProgress } from "./NeighborsTab";

/**
 * CLUSTERS tab (TZ §8.1, §8.2): automatic DBSCAN clustering over an
 * EXPLICIT space (original vectors or one projection — the run list says
 * which one produced the labels) + manual groups saved from the current
 * selection. Manual groups are independent entities: clustering never
 * overwrites them, and clusters are never renamed to "topics".
 */

export function ClustersTab() {
  const runs = useExperimentStore((s) => s.runs);
  const projections = useExperimentStore((s) => s.projections);
  const loadRuns = useExperimentStore((s) => s.loadRuns);
  const loadProjections = useExperimentStore((s) => s.loadProjections);

  const clusteringRuns = useAnalysisStore((s) => s.clusteringRuns);
  const groups = useAnalysisStore((s) => s.groups);
  const activeJob = useAnalysisStore((s) => s.activeJob);
  const error = useAnalysisStore((s) => s.error);
  const loadClustering = useAnalysisStore((s) => s.loadClustering);
  const startClustering = useAnalysisStore((s) => s.startClustering);
  const deleteClustering = useAnalysisStore((s) => s.deleteClustering);
  const showClusteringOnScene = useAnalysisStore((s) => s.showClusteringOnScene);
  const loadGroups = useAnalysisStore((s) => s.loadGroups);
  const createGroup = useAnalysisStore((s) => s.createGroup);
  const deleteGroup = useAnalysisStore((s) => s.deleteGroup);

  const selectedIds = useProjectStore((s) => s.selectedFragmentIds);
  const setSelectedFragments = useProjectStore((s) => s.setSelectedFragments);
  const colorBy = useSpaceStore((s) => s.colorBy);
  const clusterCaption = useSpaceStore((s) => s.clusterCaption);
  const setColorBy = useSpaceStore((s) => s.setColorBy);

  const [space, setSpace] = useState<ClusteringSpace>("original");
  const [projectionId, setProjectionId] = useState("");
  const [eps, setEps] = useState(0.5);
  const [minSamples, setMinSamples] = useState(5);
  const [groupName, setGroupName] = useState("");

  useEffect(() => {
    void loadRuns();
    void loadProjections();
    void loadClustering();
    void loadGroups();
  }, [loadRuns, loadProjections, loadClustering, loadGroups]);

  const jobRunning = activeJob?.state === "queued" || activeJob?.state === "running";
  const embeddingRunId = runs?.[0]?.id ?? null;
  const projectionOptions = (projections ?? []).filter((p) => p.cache_ok);
  const metric = space === "projection" ? "euclidean" : "cosine";
  const canStart =
    !jobRunning &&
    embeddingRunId !== null &&
    eps > 0 &&
    minSamples >= 2 &&
    (space === "original" || projectionId !== "");

  const onStart = () => {
    if (!embeddingRunId) return;
    void startClustering({
      embedding_run_id: embeddingRunId,
      space,
      projection_run_id: space === "projection" ? projectionId : null,
      algorithm: "dbscan",
      metric,
      params: { eps, min_samples: minSamples },
    });
  };

  const onSaveGroup = async () => {
    const name = groupName.trim();
    if (!name || selectedIds.length === 0) return;
    const ok = await createGroup(name, selectedIds);
    if (ok) setGroupName("");
  };

  return (
    <div className="analysis-pane" aria-label="Кластеры и группы">
      {error && (
        <div className="proj-controls__error" role="alert">
          {error.message}
          {error.hint && <span className="workspace-error__hint"> {error.hint}</span>}
        </div>
      )}

      {/* --- automatic clustering form --- */}
      <h4 className="analysis-pane__subtitle">Автокластеризация (DBSCAN)</h4>
      <div className="analysis-pane__controls analysis-pane__controls--wrap">
        <label className="analysis-pane__field analysis-pane__field--wide">
          <span>пространство</span>
          <select
            className="proj-controls__select mono"
            value={space}
            aria-label="Пространство кластеризации"
            disabled={jobRunning}
            onChange={(e) => setSpace(e.target.value as ClusteringSpace)}
          >
            <option value="original">исходные векторы ({metric})</option>
            <option value="projection">координаты проекции (euclidean)</option>
          </select>
        </label>
        {space === "projection" && (
          <label className="analysis-pane__field analysis-pane__field--wide">
            <span>проекция</span>
            <select
              className="proj-controls__select mono"
              value={projectionId}
              aria-label="Проекция для кластеризации"
              disabled={jobRunning}
              onChange={(e) => setProjectionId(e.target.value)}
            >
              <option value="">— выберите —</option>
              {projectionOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.method_display_name} · {p.n_components}D{p.stale ? " · УСТАРЕЛА" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="analysis-pane__field">
          <span>eps</span>
          <input
            type="number"
            className="proj-controls__input mono"
            value={eps}
            min={0.01}
            step={0.05}
            aria-label="eps (радиус окрестности)"
            disabled={jobRunning}
            onChange={(e) => {
              const value = Number.parseFloat(e.target.value);
              if (Number.isFinite(value)) setEps(value);
            }}
          />
        </label>
        <label className="analysis-pane__field">
          <span>min_samples</span>
          <input
            type="number"
            className="proj-controls__input mono"
            value={minSamples}
            min={2}
            step={1}
            aria-label="min_samples"
            disabled={jobRunning}
            onChange={(e) => {
              const value = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(value)) setMinSamples(value);
            }}
          />
        </label>
        <button
          type="button"
          className="btn btn--small btn--primary"
          disabled={!canStart}
          onClick={onStart}
        >
          Запустить DBSCAN
        </button>
      </div>
      {!embeddingRunId && (
        <div className="empty-hint">
          Кластеризация считается по эмбеддингам — сначала рассчитайте их в
          разделе EXPERIMENTS.
        </div>
      )}
      <AnalysisJobProgress />

      {/* --- clustering runs --- */}
      {clusteringRuns && clusteringRuns.length > 0 && (
        <ul className="cluster-runs">
          {clusteringRuns.map((run) => (
            <li key={run.id} className="cluster-runs__item">
              <span className="cluster-runs__label mono">
                {run.algorithm.toUpperCase()} ·{" "}
                {run.space === "projection" ? `проекция ${run.projection_run_id}` : "исходное"} ·{" "}
                {run.metric} · eps {run.params.eps} · ms {run.params.min_samples}
              </span>
              <span className="cluster-runs__stats mono">
                кластеров: {run.n_clusters}, шум: {run.noise}/{run.count}
              </span>
              {run.stale && (
                <span className="badge badge--warn" title="Векторы изменились после расчёта">
                  устарела
                </span>
              )}
              {!run.cache_ok && <span className="badge badge--warn">кэш повреждён</span>}
              <button
                type="button"
                className="btn btn--small"
                onClick={() => void showClusteringOnScene(run.id)}
                disabled={!run.cache_ok}
                title="Раскрасить точки сцен по меткам этого запуска"
              >
                На сцену
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => void deleteClustering(run.id)}
                aria-label={`Удалить запуск кластеризации ${run.id}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {colorBy === "cluster" && clusterCaption && (
        <p className="analysis-pane__note">
          Сцены раскрашены по кластерам: {clusterCaption}. Переключатель
          «цвет: тип/кластер» — в тулбаре сцены. Точки без метки в выбранном
          запуске показываются серыми («без метки») — это честно, а не «свой
          кластер».
        </p>
      )}
      {colorBy === "cluster" && (
        <button
          type="button"
          className="btn btn--small"
          onClick={() => setColorBy("kind")}
        >
          Вернуть раскраску по типу
        </button>
      )}

      {/* --- manual groups --- */}
      <h4 className="analysis-pane__subtitle">Ручные группы</h4>
      <div className="analysis-pane__controls">
        <input
          type="text"
          className="proj-controls__input proj-controls__input--name"
          value={groupName}
          placeholder="имя группы"
          aria-label="Имя группы"
          maxLength={128}
          onChange={(e) => setGroupName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onSaveGroup();
          }}
        />
        <button
          type="button"
          className="btn btn--small"
          disabled={!groupName.trim() || selectedIds.length === 0}
          onClick={() => void onSaveGroup()}
          title={
            selectedIds.length === 0
              ? "Сначала выделите точки (клик/Ctrl-клик/Shift-рамка на сцене)"
              : "Сохранить текущее выделение как именованную группу"
          }
        >
          Сохранить выделение ({selectedIds.length})
        </button>
      </div>
      {groups && groups.length > 0 && (
        <ul className="cluster-runs">
          {groups.map((group) => (
            <li key={group.id} className="cluster-runs__item">
              <button
                type="button"
                className="cluster-runs__label cluster-runs__label--btn mono"
                onClick={() => setSelectedFragments(group.fragment_ids)}
                title="Выделить фрагменты группы во всех представлениях"
              >
                {group.name} · {group.count} фрагм.
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => void deleteGroup(group.id)}
                aria-label={`Удалить группу «${group.name}»`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="analysis-pane__note">
        Группы хранят ID фрагментов и не перезаписываются автокластеризацией;
        фрагменты, удалённые при переиндексации, покидают группу (счётчик
        честный).
      </p>
    </div>
  );
}
