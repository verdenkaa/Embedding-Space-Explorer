import { useEffect, useMemo, useRef, useState } from "react";

import type { ProjectionMethodInfo, ProjectionParamSpec } from "../../api/types";
import { axesSetsKey, parseAxesInput } from "../../space/axisSpec";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useUiStore } from "../../state/uiStore";
import { JobProgress } from "../corpus/JobProgress";

/**
 * Projection control panel (bottom of the SPACE center column — moved there
 * by user feedback; between the charts it competed with the data).
 *
 * The view selectors ("3D-вид" / "2D-вид" / "4D-вид") and the projection
 * cleanup buttons live in the TOP bar next to the view-mode toggle now
 * (user feedback): the panel builds, the top bar shows and cleans up.
 *
 * Form fields carry NO hover tooltips (they were clipped and uninformative):
 * parameter names are self-descriptive, ranges are enforced by inputs, and
 * the method's honesty caveat is a permanent full-width line instead.
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

/* ------------------------------------------------------------------ */
/* Parameter inputs rendered from the backend catalog specs */
/* ------------------------------------------------------------------ */

interface AxesInputProps {
  spec: ProjectionParamSpec;
  sets: number[][];
  dimHint: number | null;
  onEmit: (sets: number[][], problem: string | null) => void;
}

/**
 * Raw-axes picker: "12, 57" (one plot) or "0,1;0,2;0,3" (several 2D plots
 * side by side — one projection per `;`-separated pair). Validation is
 * instant and inline; the backend re-validates everything.
 */
export function AxesInput({ spec, sets, dimHint, onEmit }: AxesInputProps) {
  const [text, setText] = useState(() => sets.map((s) => s.join(", ")).join("; "));
  const [problem, setProblem] = useState<string | null>(null);
  const lastEmitted = useRef(axesSetsKey(sets));

  // External changes (preset applied, method switch) refresh the field.
  useEffect(() => {
    const external = axesSetsKey(sets);
    if (external !== lastEmitted.current) {
      lastEmitted.current = external;
      setText(sets.map((s) => s.join(", ")).join("; "));
      setProblem(null);
    }
  }, [sets]);

  const handleChange = (next: string) => {
    setText(next);
    const parsed = parseAxesInput(next, dimHint);
    setProblem(parsed.problem);
    lastEmitted.current = axesSetsKey(parsed.sets);
    onEmit(parsed.sets, parsed.problem);
  };

  return (
    <span className="proj-controls__field proj-controls__field--axes">
      <span id={`axes-label-${spec.name}`}>{spec.name}</span>
      <input
        type="text"
        className={`proj-controls__input proj-controls__input--axes mono${
          problem ? " proj-controls__input--invalid" : ""
        }`}
        value={text}
        aria-labelledby={`axes-label-${spec.name}`}
        aria-invalid={problem !== null}
        placeholder={dimHint !== null ? `0..${dimHint - 1}; «0,1;0,2» — графики рядом` : "12, 57"}
        spellCheck={false}
        onChange={(e) => handleChange(e.target.value)}
      />
      {problem && <span className="proj-controls__problem">{problem}</span>}
    </span>
  );
}

function MethodParams({
  method,
  dimHint,
}: {
  method: ProjectionMethodInfo | null;
  dimHint: number | null;
}) {
  const projParams = useExperimentStore((s) => s.projParams);
  const projAxesGroups = useExperimentStore((s) => s.projAxesGroups);
  const setProjParam = useExperimentStore((s) => s.setProjParam);
  const setProjAxesState = useExperimentStore((s) => s.setProjAxesState);
  if (!method) return null;
  return (
    <>
      {method.params.map((spec) => {
        const value = projParams[spec.name] ?? spec.default;
        if (spec.type === "int_list") {
          const sets =
            projAxesGroups.length > 0
              ? projAxesGroups
              : Array.isArray(value) && value.length > 0
                ? [value]
                : [];
          return (
            <AxesInput
              key={spec.name}
              spec={spec}
              sets={sets}
              dimHint={dimHint}
              onEmit={(parsed, problem) => setProjAxesState(parsed, problem)}
            />
          );
        }
        if (spec.type === "bool") {
          return (
            <label
              key={spec.name}
              className="proj-controls__field proj-controls__field--bool"
            >
              <input
                type="checkbox"
                checked={Boolean(value)}
                aria-label={spec.name}
                onChange={(e) => setProjParam(spec.name, e.target.checked)}
              />
              <span>{spec.name}</span>
            </label>
          );
        }
        if (spec.type === "choice") {
          return (
            <label key={spec.name} className="proj-controls__field">
              <span>{spec.name}</span>
              <select
                className="proj-controls__select mono"
                value={String(value)}
                aria-label={spec.name}
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
          <label key={spec.name} className="proj-controls__field">
            <span>{spec.name}</span>
            <input
              type="number"
              className="proj-controls__input mono"
              value={Number(value)}
              aria-label={spec.name}
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

/* ------------------------------------------------------------------ */
/* Panel */
/* ------------------------------------------------------------------ */

export function ProjectionControls() {
  const current = useProjectStore((s) => s.current);

  const runs = useExperimentStore((s) => s.runs);
  const presets = useExperimentStore((s) => s.presets);
  const methods = useExperimentStore((s) => s.projectionMethods);
  const activeJob = useExperimentStore((s) => s.activeJob);
  const error = useExperimentStore((s) => s.error);
  const projRunId = useExperimentStore((s) => s.projRunId);
  const projMethod = useExperimentStore((s) => s.projMethod);
  const projParams = useExperimentStore((s) => s.projParams);
  const projSeed = useExperimentStore((s) => s.projSeed);
  const projAxesGroups = useExperimentStore((s) => s.projAxesGroups);
  const projAxesProblem = useExperimentStore((s) => s.projAxesProblem);
  const presetName = useExperimentStore((s) => s.presetName);
  const loadProjectionCatalog = useExperimentStore((s) => s.loadProjectionCatalog);
  const loadPresets = useExperimentStore((s) => s.loadPresets);
  const setProjRunId = useExperimentStore((s) => s.setProjRunId);
  const setProjMethod = useExperimentStore((s) => s.setProjMethod);
  const setProjSeed = useExperimentStore((s) => s.setProjSeed);
  const setPresetName = useExperimentStore((s) => s.setPresetName);
  const startProjection = useExperimentStore((s) => s.startProjection);
  const savePreset = useExperimentStore((s) => s.savePreset);
  const deletePreset = useExperimentStore((s) => s.deletePreset);
  const applyPreset = useExperimentStore((s) => s.applyPreset);

  const setActiveSection = useUiStore((s) => s.setActiveSection);

  // Runs and inventory are loaded by SpaceSection; the panel itself loads
  // the method catalog and presets (its own concerns).
  useEffect(() => {
    if (!current) return;
    void loadProjectionCatalog();
    void loadPresets();
  }, [current, loadProjectionCatalog, loadPresets]);

  const jobRunning = activeJob?.state === "queued" || activeJob?.state === "running";
  const effectiveRunId = projRunId ?? runs?.[0]?.id ?? null;
  const method = methods?.find((m) => m.method_id === projMethod) ?? null;
  const selectedRun = runs?.find((r) => r.id === effectiveRunId) ?? null;
  const isRawAxes = projMethod === "raw_axes";
  const axes = projParams["axes"];
  const axesCount = Array.isArray(axes) ? axes.length : 0;
  const isMulti = projAxesProblem === null && projAxesGroups.length > 1;

  const buildLabel = useMemo(() => {
    if (isRawAxes) {
      if (isMulti) return `Построить графики (2D×${projAxesGroups.length})`;
      return axesCount === 4
        ? "Построить проекцию (4D)"
        : axesCount === 3
          ? "Построить проекцию (3D)"
          : axesCount === 2
            ? "Построить проекцию (2D)"
            : "Построить проекцию";
    }
    return "Построить проекцию (3D+2D)";
  }, [isRawAxes, isMulti, projAxesGroups, axesCount]);

  const rawAxesInvalid =
    isRawAxes && (projAxesProblem !== null || (!isMulti && (axesCount < 2 || axesCount > 4)));
  const buildDisabled = jobRunning || runs === null || runs.length === 0 || !current || rawAxesInvalid;

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
        onCancel={() => void useExperimentStore.getState().cancelActiveJob()}
        runningLabel={
          activeJob?.kind === "projection"
            ? "проекция"
            : activeJob?.kind === "model_download"
              ? "скачивание модели"
              : "эмбеддинги"
        }
      />

      <div className="proj-controls__row">
        <label className="proj-controls__field">
          <span>векторы</span>
          <select
            className="proj-controls__select proj-controls__select--wide mono"
            value={effectiveRunId ?? ""}
            aria-label="Запуск эмбеддингов — источник векторов"
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

        <label className="proj-controls__field">
          <span>метод</span>
          <select
            className="proj-controls__select mono"
            value={projMethod}
            aria-label="Метод проекции"
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

        <MethodParams method={method} dimHint={selectedRun?.dim ?? null} />

        <label className="proj-controls__field">
          <span>seed</span>
          <input
            type="number"
            className="proj-controls__input mono"
            min={0}
            value={projSeed}
            aria-label="Random seed"
            disabled={jobRunning || isRawAxes}
            onChange={(e) => setProjSeed(Number.parseInt(e.target.value, 10) || 0)}
          />
        </label>

        <button
          type="button"
          className="btn btn--small btn--primary"
          disabled={buildDisabled}
          onClick={() => void startProjection()}
        >
          {buildLabel}
        </button>
        {!isRawAxes && (
          <button
            type="button"
            className="btn btn--small"
            disabled={buildDisabled}
            title="Построить проекцию с четырьмя компонентами для 4D-вида ( четвёртая ось — слайдер «времени»)"
            onClick={() => void startProjection({ components: [4] })}
          >
            Построить 4D
          </button>
        )}

        {noEmbeddings && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setActiveSection("experiments")}
          >
            Рассчитать эмбеддинги…
          </button>
        )}
      </div>

      <div className="proj-controls__row">
        <label className="proj-controls__field">
          <span>пресет</span>
          <select
            className="proj-controls__select proj-controls__select--wide mono"
            value=""
            aria-label="Сохранённые пресеты проекций"
            disabled={(presets ?? []).length === 0}
            onChange={(e) => {
              if (e.target.value) applyPreset(e.target.value);
            }}
          >
            <option value="">
              {(presets ?? []).length === 0 ? "— нет сохранённых —" : "— применить —"}
            </option>
            {(presets ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.method_display_name}
                {p.method === "raw_axes" && Array.isArray(p.params["axes"])
                  ? ` [${(p.params["axes"] as number[]).join(", ")}]`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          className="proj-controls__input proj-controls__input--name"
          value={presetName}
          placeholder="имя пресета"
          aria-label="Имя нового пресета"
          maxLength={128}
          onChange={(e) => setPresetName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && presetName.trim() && !isMulti) void savePreset();
          }}
        />
        <button
          type="button"
          className="btn btn--small"
          disabled={!presetName.trim() || jobRunning || isMulti}
          title={
            isMulti
              ? "Пресет сохраняет одну комбинацию осей — оставьте одну группу (до «;»)"
              : "Сохранить текущую форму (метод, параметры, seed) как пресет"
          }
          onClick={() => void savePreset()}
        >
          Сохранить пресет
        </button>
        <DeletePresetButton
          presets={presets}
          projMethod={projMethod}
          projParams={projParams}
          projSeed={projSeed}
          onDelete={(id) => void deletePreset(id)}
        />
      </div>

      {method && (
        <p className="proj-controls__caveat">
          <b>{method.display_name}:</b> {method.caveat}
        </p>
      )}
    </div>
  );
}

/** Delete button targets the preset matching the CURRENT form (if any). */
function DeletePresetButton({
  presets,
  projMethod,
  projParams,
  projSeed,
  onDelete,
}: {
  presets: ReturnType<typeof useExperimentStore.getState>["presets"];
  projMethod: string;
  projParams: Record<string, unknown>;
  projSeed: number;
  onDelete: (id: string) => void;
}) {
  const stable = (obj: Record<string, unknown>) =>
    JSON.stringify(
      Object.keys(obj)
        .sort()
        .map((k) => [k, obj[k]]),
    );
  const match = (presets ?? []).find(
    (p) =>
      p.method === projMethod &&
      p.seed === projSeed &&
      stable(p.params) === stable(projParams),
  );
  if (!match) return null;
  return (
    <button
      type="button"
      className="btn btn--small btn--danger"
      onClick={() => onDelete(match.id)}
      aria-label={`Удалить пресет «${match.name}»`}
    >
      Удалить «{match.name}»
    </button>
  );
}
