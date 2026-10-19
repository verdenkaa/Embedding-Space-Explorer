import { useEffect, useRef, useState } from "react";

import { exportUrls } from "../../api/client";
import { downloadFromApi } from "../../api/download";
import { runOptionLabel } from "../../space/projectionLabels";
import { exportScenesPng } from "../../space/sceneCapture";
import { useProjectStore } from "../../state/projectStore";
import { useExperimentStore } from "../../state/experimentStore";
import {
  useSpaceStore,
  type CloudKind,
  type ColorBy,
  type GridMode,
  type ViewMode,
} from "../../state/spaceStore";

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

const COLOR_MODES: { id: ColorBy; label: string; hint: string }[] = [
  { id: "kind", label: "тип", hint: "Окраска по типу фрагмента (fn / mth / cls / …)" },
  { id: "file", label: "файл", hint: "Окраска по типу файла (расширению)" },
  { id: "cluster", label: "кластер", hint: "Окраска по кластеру выбранного запуска DBSCAN" },
];

/** Point-coloring mode (shared by every view): fragment kind / file type / cluster. */
export function ColorModeControl() {
  const colorBy = useSpaceStore((s) => s.colorBy);
  const setColorBy = useSpaceStore((s) => s.setColorBy);
  const clusterLabels = useSpaceStore((s) => s.clusterLabels);
  return (
    <div className="view-bar__group" title="Раскраска точек">
      <span className="view-bar__group-label mono">цвет</span>
      <div className="view-mode" role="group" aria-label="Режим окраски">
        {COLOR_MODES.map((mode) => {
          const disabled = mode.id === "cluster" && !clusterLabels;
          return (
            <button
              key={mode.id}
              type="button"
              className={`view-mode__btn${colorBy === mode.id ? " view-mode__btn--active" : ""}`}
              disabled={disabled}
              onClick={() => setColorBy(mode.id)}
              aria-pressed={colorBy === mode.id}
              title={
                disabled
                  ? "Сначала запустите кластеризацию и нажмите «На сцену» во вкладке CLUSTERS"
                  : mode.hint
              }
            >
              {mode.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const GRID_MODES: { id: GridMode; label: string; hint: string }[] = [
  { id: "off", label: "выкл", hint: "Выключена: без координатной сетки и делений" },
  { id: "simple", label: "простая", hint: "Простая: равномерная сетка без числовых подписей" },
  { id: "numbers", label: "цифры", hint: "С цифрами осей: сетка + действительные значения координат" },
];

/** Coordinate-grid mode (shared by the 2D and 3D/4D views). */
export function GridModeControl() {
  const gridMode = useSpaceStore((s) => s.gridMode);
  const setGridMode = useSpaceStore((s) => s.setGridMode);
  return (
    <div className="view-bar__group" title="Координатная сетка">
      <span className="view-bar__group-label mono">сетка</span>
      <div className="view-mode" role="group" aria-label="Режим координатной сетки">
        {GRID_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={`view-mode__btn${gridMode === mode.id ? " view-mode__btn--active" : ""}`}
            onClick={() => setGridMode(mode.id)}
            aria-pressed={gridMode === mode.id}
            title={mode.hint}
          >
            {mode.label}
          </button>
        ))}
      </div>
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

/** Two-step "delete everything computed" (destructive → confirm). */
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

/**
 * Export menu: images of the live
 * scenes (client-side canvas capture — what you see is what you get) and
 * CSV/JSON of explicitly chosen data (the active projection's points, the
 * current selection, all relations).
 */
export function ExportMenu() {
  const current = useProjectStore((s) => s.current);
  const selectedIds = useProjectStore((s) => s.selectedFragmentIds);
  const viewMode = useSpaceStore((s) => s.viewMode);
  const cloud3d = useSpaceStore((s) => s.cloud3d);
  const clouds2d = useSpaceStore((s) => s.clouds2d);
  const cloud4d = useSpaceStore((s) => s.cloud4d);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!current) return null;
  const pid = current.id;
  const activeCloud =
    viewMode === "2d" ? clouds2d[0] : viewMode === "4d" ? cloud4d : cloud3d;
  const hasScene = viewMode !== "2d" ? Boolean(cloud3d ?? cloud4d) : clouds2d.length > 0;

  const run = async (fn: () => Promise<void> | void, okMessage: string) => {
    try {
      await fn();
      setNotice(okMessage);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    window.setTimeout(() => setNotice(null), 4000);
  };

  return (
    <div className="export-menu" ref={rootRef}>
      <button
        type="button"
        className="btn btn--small export-menu__toggle"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        title="Экспорт изображений сцен и выбранных данных (CSV/JSON)"
      >
        ⤓ Экспорт
      </button>
      {open && (
        <div className="export-menu__popup" role="menu" aria-label="Экспорт">
          <button
            type="button"
            role="menuitem"
            disabled={!hasScene}
            onClick={() => {
              const n = exportScenesPng(viewMode);
              setNotice(n > 0 ? `Сохранено изображений: ${n}` : "На экране нет сцен");
              window.setTimeout(() => setNotice(null), 4000);
              setOpen(false);
            }}
            title="PNG того, что сейчас на экране (сцены и 2D-графики)"
          >
            Сцены на экране → PNG
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!activeCloud}
            onClick={() =>
              void run(() => {
                if (!activeCloud) return;
                return downloadFromApi(
                  exportUrls.projectionPoints(pid, activeCloud.projection.id, "csv"),
                  "points.csv",
                );
              }, "Точки проекции сохранены (CSV)")
            }
            title={
              activeCloud
                ? `CSV: координаты + метаданные всех точек (${activeCloud.projection.method_display_name} · ${activeCloud.points.count})`
                : "В активном виде ничего не показано"
            }
          >
            Точки активной проекции → CSV
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={selectedIds.length === 0}
            onClick={() =>
              void run(
                () =>
                  downloadFromApi(exportUrls.fragments(pid), "selection.csv", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fragment_ids: selectedIds }),
                  }),
                `Выделение сохранено (CSV, ${selectedIds.length})`,
              )
            }
            title="CSV метаданных выделенных фрагментов (пути, строки, символы)"
          >
            Выделение ({selectedIds.length}) → CSV
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(
                () => downloadFromApi(exportUrls.relations(pid), "relations.csv"),
                "Связи сохранены (CSV)",
              )
            }
            title="CSV всех структурных связей (с происхождением и свидетельствами)"
          >
            Все связи → CSV
          </button>
          {notice && <div className="export-menu__notice">{notice}</div>}
        </div>
      )}
    </div>
  );
}

/** The whole top bar: mode toggle + per-mode selectors + color/grid + cleanup + export. */
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
      <span className="view-bar__separator" aria-hidden="true" />
      <ColorModeControl />
      <GridModeControl />
      <span className="view-bar__separator" aria-hidden="true" />
      <ExportMenu />
    </div>
  );
}
