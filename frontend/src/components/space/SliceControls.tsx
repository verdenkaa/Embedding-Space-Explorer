import { useEffect, useMemo, useState } from "react";

import { inLayer } from "../../space/sliceMath";
import { useAnalysisStore } from "../../state/analysisStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";

/**
 * Slice panel (UI-ТЗ §4, TZ §5.3/§5.4): a MATHEMATICAL layer of the ORIGINAL
 * embedding space, laid over whichever projections the views show.
 *
 * - the backend resolves the normal (an original-space axis, a deterministic
 *   PCA direction, or a saved explicit vector) and serves u(x) = dot(x-c, n)
 *   for every fragment ONCE per (run, normal);
 * - position/thickness sliders re-mask client-side (no round-trips);
 * - the panel always states that this is a selection in the original space
 *   displayed through a projection — never "a cut of the picture";
 * - views apply the slice only to clouds of the SAME embedding run (a
 *   mismatch is reported here instead of silently showing nothing).
 */

export function SliceControls() {
  const current = useProjectStore((s) => s.current);
  const runs = useExperimentStore((s) => s.runs);
  const cloud3d = useSpaceStore((s) => s.cloud3d);
  const clouds2d = useSpaceStore((s) => s.clouds2d);
  const cloud4d = useSpaceStore((s) => s.cloud4d);
  const overlay = useSpaceStore((s) => s.sliceOverlay);
  const display = useSpaceStore((s) => s.sliceDisplay);
  const setSliceDisplay = useSpaceStore((s) => s.setSliceDisplay);
  const patchSliceOverlay = useSpaceStore((s) => s.patchSliceOverlay);
  const setSliceOverlay = useSpaceStore((s) => s.setSliceOverlay);

  const savedSlices = useAnalysisStore((s) => s.savedSlices);
  const sliceLoading = useAnalysisStore((s) => s.sliceLoading);
  const error = useAnalysisStore((s) => s.error);
  const loadSavedSlices = useAnalysisStore((s) => s.loadSavedSlices);
  const computeSlice = useAnalysisStore((s) => s.computeSlice);
  const saveSlice = useAnalysisStore((s) => s.saveSlice);
  const deleteSavedSlice = useAnalysisStore((s) => s.deleteSavedSlice);
  const applySavedSlice = useAnalysisStore((s) => s.applySavedSlice);

  const [enabled, setEnabled] = useState(false);
  const [runId, setRunId] = useState<string>("");
  const [normalKind, setNormalKind] = useState<"axis" | "pca">("axis");
  const [indexInput, setIndexInput] = useState(0);
  const [appliedIndex, setAppliedIndex] = useState(0);
  const [sliceName, setSliceName] = useState("");

  const effectiveRunId = runId || runs?.[0]?.id || "";
  const [lastSavedId, setLastSavedId] = useState("");

  useEffect(() => {
    if (!current) return;
    void loadSavedSlices();
  }, [current, loadSavedSlices]);

  /* Fetch u(x) once per (run, normal); sliders afterwards are local math. */
  useEffect(() => {
    if (!enabled || !effectiveRunId) return;
    void computeSlice(effectiveRunId, normalKind, appliedIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, effectiveRunId, normalKind, appliedIndex]);

  const inLayerCount = useMemo(() => {
    if (!overlay) return null;
    let n = 0;
    for (const u of overlay.uById.values()) {
      if (inLayer(u, overlay)) n += 1;
    }
    return n;
  }, [overlay]);

  const mismatchedViews = useMemo(() => {
    if (!overlay) return 0;
    let n = 0;
    if (cloud3d && cloud3d.projection.embedding_run_id !== overlay.embeddingRunId) n += 1;
    if (cloud4d && cloud4d.projection.embedding_run_id !== overlay.embeddingRunId) n += 1;
    for (const c of clouds2d) {
      if (c.projection.embedding_run_id !== overlay.embeddingRunId) n += 1;
    }
    return n;
  }, [overlay, cloud3d, cloud4d, clouds2d]);

  const range = overlay ? overlay.uMax - overlay.uMin : 0;
  const selectedRunDim = runs?.find((r) => r.id === effectiveRunId)?.dim ?? null;

  return (
    <div className="slice-panel" aria-label="Срез исходного пространства">
      <div className="slice-panel__row">
        <button
          type="button"
          className="slice-panel__toggle btn btn--small"
          onClick={() => {
            const next = !enabled;
            setEnabled(next);
            if (!next) setSliceOverlay(null);
          }}
          aria-pressed={enabled}
          title="Математический срез ИСХОДНОГО embedding-пространства: слой |dot(x-p,n)| <= t/2 вокруг гиперплоскости"
        >
          {enabled ? "▣" : "▢"} Срез
        </button>

        {enabled && (
          <>
            <label className="slice-panel__field">
              <span>векторы</span>
              <select
                className="proj-controls__select mono"
                value={effectiveRunId}
                aria-label="Запуск эмбеддингов для среза"
                onChange={(e) => setRunId(e.target.value)}
              >
                {(runs ?? []).map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.model_display_name} · {run.mode} · {run.dim}d
                  </option>
                ))}
              </select>
            </label>
            <label className="slice-panel__field">
              <span>нормаль</span>
              <select
                className="proj-controls__select mono"
                value={normalKind}
                aria-label="Способ задания нормали"
                onChange={(e) => setNormalKind(e.target.value as "axis" | "pca")}
              >
                <option value="axis">ось пространства</option>
                <option value="pca">направление PCA</option>
              </select>
            </label>
            <label className="slice-panel__field">
              <span>{normalKind === "axis" ? "dim" : "PC"}</span>
              <input
                type="number"
                className="proj-controls__input mono slice-panel__index"
                min={0}
                max={selectedRunDim !== null ? selectedRunDim - 1 : undefined}
                value={indexInput}
                aria-label="Индекс нормали"
                onChange={(e) => {
                  const value = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(value)) setIndexInput(Math.max(0, value));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setAppliedIndex(indexInput);
                }}
              />
              <button
                type="button"
                className="btn btn--small"
                onClick={() => setAppliedIndex(indexInput)}
                disabled={appliedIndex === indexInput}
                title="Пересчитать нормаль и координаты вдоль неё"
              >
                применить
              </button>
            </label>
          </>
        )}
      </div>

      {enabled && overlay && (
        <>
          <div className="slice-panel__row">
            <label className="slice-panel__slider">
              <span className="mono">позиция</span>
              <input
                type="range"
                min={overlay.uMin}
                max={overlay.uMax}
                step={range > 0 ? range / 500 : 0.001}
                value={Math.min(Math.max(overlay.position, overlay.uMin), overlay.uMax)}
                aria-label="Позиция слоя вдоль нормали"
                onChange={(e) =>
                  patchSliceOverlay({ position: Number.parseFloat(e.target.value) })
                }
              />
              <span className="mono slice-panel__value">{overlay.position.toFixed(4)}</span>
            </label>
            <label className="slice-panel__slider">
              <span className="mono">толщина</span>
              <input
                type="range"
                min={0}
                max={Math.max(range, 1e-6)}
                step={range > 0 ? range / 200 : 0.001}
                value={Math.min(overlay.thickness, range)}
                aria-label="Толщина слоя"
                onChange={(e) =>
                  patchSliceOverlay({ thickness: Number.parseFloat(e.target.value) })
                }
              />
              <span className="mono slice-panel__value">{overlay.thickness.toFixed(4)}</span>
            </label>
            <span className="slice-panel__count mono" role="status">
              {sliceLoading ? "пересчёт…" : `в слое ${inLayerCount ?? 0} из ${overlay.total}`}
            </span>
            <span className="slice-panel__modes" role="radiogroup" aria-label="Отображение среза">
              {(
                [
                  ["dim", "затемнять"],
                  ["only", "только слой"],
                  ["off", "все точки"],
                ] as const
              ).map(([mode, label]) => (
                <label key={mode} className="slice-panel__mode">
                  <input
                    type="radio"
                    name="slice-display"
                    checked={display === mode}
                    onChange={() => setSliceDisplay(mode)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </span>
          </div>
          <div className="slice-panel__row">
            <label className="slice-panel__field">
              <span>сохранённые</span>
              <select
                className="proj-controls__select mono"
                value=""
                aria-label="Сохранённые срезы"
                disabled={!savedSlices || savedSlices.length === 0}
                onChange={(e) => {
                  if (e.target.value) {
                    setLastSavedId(e.target.value);
                    void applySavedSlice(e.target.value);
                  }
                }}
              >
                <option value="">
                  {!savedSlices || savedSlices.length === 0 ? "— нет —" : "— применить —"}
                </option>
                {(savedSlices ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.normal_kind === "pca" ? `PC${(s.normal_index ?? 0) + 1}` : s.normal_kind === "axis" ? `dim ${s.normal_index}` : "вектор"} · t={s.thickness.toFixed(3)}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="text"
              className="proj-controls__input proj-controls__input--name"
              value={sliceName}
              placeholder="имя среза"
              aria-label="Имя сохраняемого среза"
              maxLength={128}
              onChange={(e) => setSliceName(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--small"
              disabled={!sliceName.trim()}
              onClick={async () => {
                await saveSlice(sliceName);
                setSliceName("");
              }}
              title="Сохранить срез: нормаль запоминается РАЗВЕРНУТЫМ единичным вектором (воспроизводимо)"
            >
              Сохранить срез
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={!lastSavedId}
              onClick={async () => {
                const id = lastSavedId;
                setLastSavedId("");
                await deleteSavedSlice(id);
              }}
              aria-label="Удалить выбранный сохранённый срез"
              title="Удалить применённый сохранённый срез"
            >
              ✕
            </button>
          </div>
          <p className="slice-panel__note">
            {overlay.note}
            {mismatchedViews > 0 && (
              <span className="slice-panel__warn">
                {" "}
                Срез посчитан по другому запуску эмбеддингов, чем {mismatchedViews} из
                показанных облаков — к ним он не применяется (членство чужих
                векторов не определено).
              </span>
            )}
          </p>
        </>
      )}

      {enabled && !overlay && (
        <p className="slice-panel__note">
          {sliceLoading
            ? "Расчёт координат вдоль нормали…"
            : "Выберите запуск эмбеддингов и нормаль — слой считается по исходным векторам."}
        </p>
      )}
      {enabled && error && (
        <div className="proj-controls__error" role="alert">
          {error.message}
          {error.hint && <span className="workspace-error__hint"> {error.hint}</span>}
        </div>
      )}
    </div>
  );
}
