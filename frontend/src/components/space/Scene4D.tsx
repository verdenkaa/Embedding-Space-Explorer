import { useEffect, useMemo, useRef } from "react";

import { layerMask4D } from "../../space/selectionMath";
import { useSpaceStore } from "../../state/spaceStore";
import { PointScene } from "./PointScene";

/**
 * 4D view (user request, stage-3 polish): a projection with FOUR components
 * rendered as the usual 3D scene over axes 1–3 plus a "time" slider over the
 * 4th axis. The slider carries a window [t ± w/2]; only points inside the
 * window are shown (hidden outside — user's choice), so dragging it shows
 * how the cloud is layered along the 4th dimension.
 *
 * Honesty (TZ §5): this is a client-side WINDOW over an already computed
 * projection — for PCA/UMAP the 4th axis belongs to the projection, for raw
 * axes it is a dimension of the original space. The badge always names the
 * method and the axis; the real slice engine (arbitrary hyperplanes in the
 * original D-dimensional space) is stage 4.
 */

const ANIM_STEP = 0.006; // fraction of the axis range per tick
const ANIM_INTERVAL_MS = 40;

export function Scene4D() {
  const cloud = useSpaceStore((s) => s.cloud4d);
  const loading = useSpaceStore((s) => s.loading4d);
  const error = useSpaceStore((s) => s.error);
  const slice = useSpaceStore((s) => s.slice4d);
  const setSlice4d = useSpaceStore((s) => s.setSlice4d);
  const setSlicePlaying = useSpaceStore((s) => s.setSlicePlaying);

  const count = cloud?.points.count ?? 0;
  const layer = useMemo(() => {
    if (!cloud || cloud.stride < 4) return null;
    return layerMask4D(cloud.coords, count, cloud.stride, 3, slice.tFrac, slice.wFrac);
  }, [cloud, count, slice.tFrac, slice.wFrac]);

  /* "Time" animation: ping-pong sweep of the window across the axis. */
  const dirRef = useRef(1);
  const playing = slice.playing;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const s = useSpaceStore.getState().slice4d;
      let t = s.tFrac + dirRef.current * ANIM_STEP;
      if (t >= 1) {
        t = 1;
        dirRef.current = -1;
      } else if (t <= 0) {
        t = 0;
        dirRef.current = 1;
      }
      setSlice4d({ tFrac: t });
    }, ANIM_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, setSlice4d]);

  /* -------- states: loading / error / empty (honest, TZ §12) -------- */

  if (!cloud && loading) {
    return (
      <div className="point-scene point-scene--state" role="status">
        <div className="empty-hint empty-hint--center">Загрузка координат проекции…</div>
      </div>
    );
  }
  if (!cloud && error) {
    return (
      <div className="point-scene point-scene--state" role="alert">
        <div className="workspace-error">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
        </div>
      </div>
    );
  }
  if (!cloud) {
    return (
      <div className="point-scene point-scene--state">
        <div className="empty-hint empty-hint--center empty-hint--accent">
          4D-вид пуст. Постройте проекцию с четырьмя компонентами: кнопка
          «Построить 4D» для PCA/UMAP или четыре оси в методе «Сырые оси».
          Первые три оси станут сценой, четвёртая — слайдером «времени».
        </div>
      </div>
    );
  }

  const projection = cloud.projection;
  const timeAxisLabel = projection.axis_labels[3] ?? "ось 4";
  const inLayer = layer?.inLayer ?? count;

  return (
    <PointScene
      cloud={cloud}
      hoverKind="4d"
      ariaLabel="4D-вид: трёхмерная сцена и слайдер четвёртой оси"
      mask={layer?.mask ?? null}
      badge={
        <span title={`Запуск ${projection.id}`}>
          {projection.method_display_name} · 4D · {projection.axis_labels.join(" / ")} · в слое{" "}
          {inLayer} из {count}
          {projection.stale && <span className="badge badge--warn"> устарела</span>}
          {!projection.stale && <span className="badge"> свежая</span>}
        </span>
      }
      footer={
        <div className="scene4d__slice" role="group" aria-label="Слайдер четвёртой оси (время)">
          <span className="scene4d__slice-label mono" title="Четвёртая компонента проекции интерпретируется как «время»">
            время: {timeAxisLabel}
          </span>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setSlicePlaying(!playing)}
            aria-pressed={playing}
            title={playing ? "Остановить развёртку времени" : "Проиграть развёртку времени"}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <label className="scene4d__slider">
            <span className="mono scene4d__slider-name">позиция</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={slice.tFrac}
              onChange={(e) => setSlice4d({ tFrac: Number.parseFloat(e.target.value) })}
              aria-label="Позиция окна по четвёртой оси"
            />
            <span className="mono scene4d__value">{layer ? layer.t.toFixed(3) : "—"}</span>
          </label>
          <label className="scene4d__slider">
            <span className="mono scene4d__slider-name">окно</span>
            <input
              type="range"
              min={0.005}
              max={1}
              step={0.005}
              value={slice.wFrac}
              onChange={(e) => setSlice4d({ wFrac: Number.parseFloat(e.target.value) })}
              aria-label="Толщина окна по четвёртой оси"
            />
            <span className="mono scene4d__value">
              ±{layer ? (layer.width / 2).toFixed(3) : "—"}
            </span>
          </label>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => setSlice4d({ tFrac: 0.5, wFrac: 1 })}
            title="Показать все точки (окно на весь диапазон четвёртой оси)"
          >
            весь диапазон
          </button>
          <span className="scene4d__count mono" role="status">
            в слое {inLayer} из {count}
          </span>
          {layer !== null && layer.inLayer === 0 && (
            <span className="scene4d__empty-hint">
              в окне нет точек — сдвиньте позицию или расширьте окно
            </span>
          )}
        </div>
      }
    />
  );
}
