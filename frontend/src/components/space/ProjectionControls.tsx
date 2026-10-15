import { useEffect } from "react";

import type { ProjectionMethodInfo } from "../../api/types";
import { runOptionLabel } from "../../space/projectionLabels";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";
import { useUiStore } from "../../state/uiStore";
import { JobProgress } from "../corpus/JobProgress";

/**
 * Compact projection control strip between the 3D scene and the 2D map
 * (UI-ТЗ §3): source embedding run, method + its declared parameters, seed,
 * compute action, and per-view switching between cached projections with
 * honest freshness badges.
 */

const JOB_POLL_MS = 1000;

/** Polls experiment-store jobs (embed/download/projection) while running. */
export function ExperimentJobPoller() {
  const activeJob = useExperimentStore((s) => s.activeJob);
  const tickActiveJob = useExperimentStore((s) => s.tickActiveJob);
  const running = activeJob?.state === "queued" || activeJob?.state === "running";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void tickActiveJob(), JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [running, tickActiveJob]);

  return null;
}

function MethodParams({ method }: { method: ProjectionMethodInfo | null }) {
  const projParams = useExperimentStore((s) => s.projParams);
  const setProjParam = useExperimentStore((s) => s.setProjParam);
  if (!method) return null;
  return (
    <>
      {method.params.map((spec) => {
        const value = projParams[spec.name] ?? spec.default;
        if (spec.type === "bool") {
          return (
            <label key={spec.name} className="proj-controls__field proj-controls__field--bool" title={spec.description}>
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => setProjParam(spec.name, e.target.checked)}
              />
              <span>{spec.name}</span>
            </label>
          );
        }
        if (spec.type === "choice") {
          return (
            <label key={spec.name} className="proj-controls__field" title={spec.description}>
              <span>{spec.name}</span>
              <select
                className="proj-controls__select mono"
                value={String(value)}
                onChange={(e) => setProjParam(spec.name, e.target.value)}
              >
                {(spec.choices ?? []).map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        return (
          <label key={spec.name} className="proj-controls__field" title={spec.description}>
            <span>{spec.name}</span>
            <input
              type="number"
              className="proj-controls__input mono"
              value={Number(value)}
              min={spec.min_value ?? undefined}
              max={spec.max_value ?? undefined}
              step={spec.step ?? (spec.type === "float" ? 0.01 : 1)}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") return;
                const num = Number.parseFloat(raw);
                if (Number.isFinite(num)) {
                  setProjParam(spec.name, spec.type === "int" ? Math.round(num) : num);
                }
              }}
            />
          </label>
        );
      })}
    </>
  );
}

export function ProjectionControls() {
  const current = useProjectStore((s) => s.current);

  const runs = useExperimentStore((s) => s.runs);
  const projections = useExperimentStore((s) => s.projections);
  const methods = useExperimentStore((s) => s.projectionMethods);
  const activeJob = useExperimentStore((s) => s.activeJob);
  const error = useExperimentStore((s) => s.error);
  const projRunId = useExperimentStore((s) => s.projRunId);
  const projMethod = useExperimentStore((s) => s.projMethod);
  const projSeed = useExperimentStore((s) => s.projSeed);
  const loadRuns = useExperimentStore((s) => s.loadRuns);
  const loadProjections = useExperimentStore((s) => s.loadProjections);
  const loadProjectionCatalog = useExperimentStore((s) => s.loadProjectionCatalog);
  const setProjRunId = useExperimentStore((s) => s.setProjRunId);
  const setProjMethod = useExperimentStore((s) => s.setProjMethod);
  const setProjSeed = useExperimentStore((s) => s.setProjSeed);
  const startProjection = useExperimentStore((s) => s.startProjection);
  const cancelActiveJob = useExperimentStore((s) => s.cancelActiveJob);

  const cloud3d = useSpaceStore((s) => s.cloud3d);
  const cloud2d = useSpaceStore((s) => s.cloud2d);
  const setActiveProjection = useSpaceStore((s) => s.setActiveProjection);
  const setActiveSection = useUiStore((s) => s.setActiveSection);

  useEffect(() => {
    if (!current) return;
    void loadRuns();
    void loadProjections();
    void loadProjectionCatalog();
  }, [current, loadRuns, loadProjections, loadProjectionCatalog]);

  const jobRunning = activeJob?.state === "queued" || activeJob?.state === "running";
  const effectiveRunId = projRunId ?? runs?.[0]?.id ?? null;
  const method = methods?.find((m) => m.method_id === projMethod) ?? null;

  const options3d = (projections ?? []).filter((p) => p.n_components === 3 && p.cache_ok);
  const options2d = (projections ?? []).filter((p) => p.n_components === 2 && p.cache_ok);

  const noEmbeddings = runs !== null && runs.length === 0;

  return (
    <div className="proj-controls" aria-label="Управление проекциями">
      <ExperimentJobPoller />

      {error && (
        <div className="proj-controls__error" role="alert">
          {error.message}
          {error.hint && <span className="workspace-error__hint"> {error.hint}</span>}
        </div>
      )}

      <JobProgress
        job={activeJob}
        onCancel={() => void cancelActiveJob()}
        runningLabel={
          activeJob?.kind === "projection"
            ? "проекция"
            : activeJob?.kind === "model_download"
              ? "скачивание модели"
              : "эмбеддинги"
        }
      />

      <div className="proj-controls__row">
        <label className="proj-controls__field" title="Запуск эмбеддингов — источник векторов">
          <span>векторы</span>
          <select
            className="proj-controls__select proj-controls__select--wide mono"
            value={effectiveRunId ?? ""}
            disabled={jobRunning || noEmbeddings}
            onChange={(e) => setProjRunId(e.target.value || null)}
          >
            {(runs ?? []).map((run) => (
              <option key={run.id} value={run.id}>
                {run.model_display_name} · {run.mode} · {run.coverage.embedded}/
                {run.coverage.fragments_total}
              </option>
            ))}
          </select>
        </label>

        <label className="proj-controls__field" title="Метод проекции (параметры и seed сохраняются)">
          <span>метод</span>
          <select
            className="proj-controls__select mono"
            value={projMethod}
            disabled={jobRunning}
            onChange={(e) => setProjMethod(e.target.value)}
          >
            {(methods ?? []).map((m) => (
              <option key={m.method_id} value={m.method_id} disabled={!m.available}>
                {m.display_name}
                {!m.available ? " (недоступен)" : ""}
              </option>
            ))}
          </select>
        </label>

        <MethodParams method={method} />

        <label className="proj-controls__field" title="Random seed: сохраняется в запуске проекции (воспроизводимость)">
          <span>seed</span>
          <input
            type="number"
            className="proj-controls__input mono"
            min={0}
            value={projSeed}
            disabled={jobRunning}
            onChange={(e) => setProjSeed(Number.parseInt(e.target.value, 10) || 0)}
          />
        </label>

        <button
          type="button"
          className="btn btn--small btn--primary"
          disabled={jobRunning || noEmbeddings || !current}
          onClick={() => void startProjection()}
          title={
            noEmbeddings
              ? "Сначала рассчитайте эмбеддинги"
              : "Построить 3D и 2D координаты из сохранённых векторов (кешируется; повтор с теми же параметрами не плодит запуски)"
          }
        >
          Построить проекцию (3D+2D)
        </button>

        {noEmbeddings && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setActiveSection("experiments")}
            title="Раздел EXPERIMENTS: скачивание модели и расчёт векторов"
          >
            Рассчитать эмбеддинги…
          </button>
        )}
      </div>

      <div className="proj-controls__row proj-controls__row--views">
        <label className="proj-controls__field" title="Какую сохранённую проекцию показывает 3D-сцена">
          <span>3D-вид</span>
          <select
            className="proj-controls__select proj-controls__select--wide mono"
            value={cloud3d?.projection.id ?? ""}
            onChange={(e) => void setActiveProjection("3d", e.target.value || null)}
          >
            <option value="">— нет —</option>
            {options3d.map((p) => (
              <option key={p.id} value={p.id}>
                {runOptionLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="proj-controls__field" title="Какую сохранённую проекцию показывает 2D-карта">
          <span>2D-вид</span>
          <select
            className="proj-controls__select proj-controls__select--wide mono"
            value={cloud2d?.projection.id ?? ""}
            onChange={(e) => void setActiveProjection("2d", e.target.value || null)}
          >
            <option value="">— нет —</option>
            {options2d.map((p) => (
              <option key={p.id} value={p.id}>
                {runOptionLabel(p)}
              </option>
            ))}
          </select>
        </label>
        {method && (
          <span className="proj-controls__caveat" title={method.description}>
            ⓘ {method.caveat}
          </span>
        )}
      </div>
    </div>
  );
}
