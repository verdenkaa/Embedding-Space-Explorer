import { useEffect, useRef, useState } from "react";

import { runOptionLabel } from "../../space/projectionLabels";
import { useExperimentStore } from "../../state/experimentStore";
import { useSpaceStore, type CloudKind, type ViewMode } from "../../state/spaceStore";

/**
 * Top bar of the SPACE center column (user feedback): the view-mode toggle
 * plus the projection selectors that used to live in the bottom panel —
 * only for the mode(s) currently on screen — plus projection cleanup
 * (delete the shown projection, or everything computed at once).
 */

const VIEW_MODES: { id: ViewMode; label: string; hint: string }[] = [
  { id: "3d", label: "3D", hint: "Только 3D-пространство" },
  { id: "2d", label: "2D", hint: "Только 2D-проекция (на всю высоту; несколько графиков рядом)" },
  { id: "4d", label: "4D", hint: "3D-сцена + слайдер четвёртой оси («время»)" },
  { id: "split", label: "3D+2D", hint: "Обе сцены одновременно (синхронное выделение)" },
];

export function ViewModeToggle() {
  const viewMode = useSpaceStore((s) => s.viewMode);
  const setViewMode = useSpaceStore((s) => s.setViewMode);
  return (
    <div className="view-mode" role="group" aria-label="Режим представления">
      {VIEW_MODES.map((mode) => (
        <button
          key={mode.id}
          type="button"
          className={`view-mode__btn${viewMode === mode.id ? " view-mode__btn--active" : ""}`}
          onClick={() => setViewMode(mode.id)}
          aria-pressed={viewMode === mode.id}
          title={mode.hint}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

const KIND_COMPONENTS: Record<CloudKind, number> = { "3d": 3, "2d": 2, "4d": 4 };

/** One "N-вид" selector: which computed projection this view shows + ✕ delete. */
export function ViewSelect({ kind }: { kind: CloudKind }) {
  const projections = useExperimentStore((s) => s.projections);
  const deleteProjection = useExperimentStore((s) => s.deleteProjection);
  const cloud3d = useSpaceStore((s) => s.cloud3d);
  const clouds2d = useSpaceStore((s) => s.clouds2d);
  const cloud4d = useSpaceStore((s) => s.cloud4d);
  const setActiveProjection = useSpaceStore((s) => s.setActiveProjection);
  const setActive2dProjections = useSpaceStore((s) => s.setActive2dProjections);

  const options = (projections ?? []).filter(
    (p) => p.n_components === KIND_COMPONENTS[kind] && p.cache_ok,
  );
  const shownIds =
    kind === "3d"
      ? cloud3d
        ? [cloud3d.projection.id]
        : []
      : kind === "2d"
        ? clouds2d.map((c) => c.projection.id)
        : cloud4d
          ? [cloud4d.projection.id]
          : [];
  const multi = shownIds.length > 1;
  const value = multi ? "__multi__" : (shownIds[0] ?? "");

  return (
    <label className="view-bar__select" title={`Проекция, показанная в ${kind}-виде`}>
      <span className="mono">{kind.toUpperCase()}-вид</span>
      <select
        className="proj-controls__select mono"
        value={value}
        aria-label={`Проекция для ${kind.toUpperCase()}-вида`}
        onChange={(e) => {
          const id = e.target.value;
          if (id === "__multi__") return;
          if (kind === "2d") {
            void (id === "" ? setActive2dProjections([]) : setActiveProjection("2d", id));
          } else {
            void setActiveProjection(kind, id === "" ? null : id);
          }
        }}
      >
        {multi && (
          <option value="__multi__" disabled>
            — несколько ({shownIds.length}) —
          </option>
        )}
        <option value="">— нет —</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {runOptionLabel(p)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn--small view-bar__delete"
        disabled={shownIds.length !== 1}
        title={
          shownIds.length === 1
            ? "Удалить эту проекцию (строку инвентаря и кэш координат)"
            : multi
              ? "Показывается несколько графиков — выберите один или используйте «Удалить все»"
              : "В этом виде ничего не показано"
        }
        aria-label={`Удалить проекцию ${kind.toUpperCase()}-вида`}
        onClick={() => {
          if (shownIds.length === 1) void deleteProjection(shownIds[0]);
        }}
      >
        ✕
      </button>
    </label>
  );
}

/** Two-step "delete everything computed" (TZ §12: destructive → confirm). */
export function DeleteAllProjectionsButton() {
  const projections = useExperimentStore((s) => s.projections);
  const deleteAllProjections = useExperimentStore((s) => s.deleteAllProjections);
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!armed) return;
    timerRef.current = window.setTimeout(() => setArmed(false), 4000);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [armed]);

  const count = (projections ?? []).length;
  if (count === 0) return null;

  if (!armed) {
    return (
      <button
        type="button"
        className="btn btn--small view-bar__delete-all"
        onClick={() => setArmed(true)}
        title="Удалить ВСЕ посчитанные проекции (векторы и пресеты не затрагиваются)"
      >
        Удалить все ({count})
      </button>
    );
  }
  return (
    <span className="view-bar__confirm" role="group" aria-label="Подтверждение удаления">
      <span className="view-bar__confirm-text">Удалить все проекции ({count})?</span>
      <button
        type="button"
        className="btn btn--small btn--danger"
        onClick={() => {
          setArmed(false);
          void deleteAllProjections();
        }}
      >
        Да
      </button>
      <button type="button" className="btn btn--small" onClick={() => setArmed(false)}>
        Нет
      </button>
    </span>
  );
}

/** The whole top bar: mode toggle + per-mode selectors + cleanup. */
export function ViewBar() {
  const viewMode = useSpaceStore((s) => s.viewMode);
  return (
    <div className="space-center__topbar view-bar">
      <ViewModeToggle />
      <span className="view-bar__separator" aria-hidden="true" />
      {(viewMode === "3d" || viewMode === "split") && <ViewSelect kind="3d" />}
      {(viewMode === "2d" || viewMode === "split") && <ViewSelect kind="2d" />}
      {viewMode === "4d" && <ViewSelect kind="4d" />}
      <DeleteAllProjectionsButton />
    </div>
  );
}
