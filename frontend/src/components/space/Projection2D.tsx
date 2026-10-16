import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { COLORS, clusterColor, kindColor } from "../../space/palette";
import { cloudSliceMask, type CloudSliceMask } from "../../space/sliceMath";
import {
  DEFAULT_PADDING,
  canvasToData,
  computeBounds2D,
  dataToCanvas,
  formatTick,
  hitTest2D,
  indicesInDataRect,
  makeTicks,
  panBounds,
  zoomBoundsAt,
  zoomLevel,
  type PlotBounds,
  type PlotGeometry,
} from "../../space/selectionMath";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore, type PointCloud, type PointMeta } from "../../state/spaceStore";
import { kindBadge } from "../../monaco/helpers";
import { toFragmentRef } from "../../space/fragmentRef";

/**
 * Synchronized 2D projection(s) (TZ §4.4, UI-ТЗ §3): the same fragments as
 * the 3D scene, sharing the selection state by fragment id. Plain canvas 2D —
 * no per-point components; redraws happen only on state changes.
 *
 * Several plots side by side: a multi axis-set build ("0,1;0,2" in the raw
 * axes field) produces one projection per pair and every plot is an ordinary
 * cached projection (own inventory entry, own staleness badge).
 *
 * Camera (user request — parity with 3D): wheel zooms towards the cursor,
 * LMB-drag pans, double-click / ⌂ returns to the auto-fit; the point size
 * slider lives in the panel header (shared with the 3D scene).
 *
 * Selection (no explicit mode buttons): Shift+drag draws a marquee (Ctrl
 * adds the area to the selection), click selects a point (Ctrl toggles),
 * Esc clears.
 *
 * Honesty (TZ §5.2/§5.4): each plot header names the projection method and
 * its axes, shows PCA explained variance when available, and states that
 * this map is a PROJECTION of all points — not a mathematical slice of the
 * original space (slices arrive at stage 4 and will be labeled separately).
 */

const PADDING = DEFAULT_PADDING;
const HIT_RADIUS_PX = 7;
const DRAG_SLOP_PX = 4;
const WHEEL_ZOOM_SPEED = 0.0016;

interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function Projection2D() {
  const clouds = useSpaceStore((s) => s.clouds2d);
  const loading = useSpaceStore((s) => s.loading2d);
  const pointSize = useSpaceStore((s) => s.pointSize);
  const setPointSize = useSpaceStore((s) => s.setPointSize);

  /* Esc clears the shared selection from any view. */
  const clearSelection = useProjectStore((s) => s.clearSelection);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  if (clouds.length === 0) {
    return (
      <section className="projection2d" aria-label="2D-проекция">
        <header className="projection2d__header">
          <span className="projection2d__title">2D-ПРОЕКЦИЯ</span>
          <span className="projection2d__spacer" />
          <span className="projection2d__note">проекция всех точек · не срез</span>
        </header>
        <div className="projection2d__canvas-wrap">
          {loading ? (
            <div className="projection2d__overlay empty-hint">Загрузка 2D-проекции…</div>
          ) : (
            <div className="projection2d__overlay empty-hint">
              2D-проекция появится вместе с 3D-пространством после «Построить проекцию».
              Несколько графиков рядом: метод «Сырые оси», ввод вида 0,1;0,2.
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="projection2d" aria-label="2D-проекция">
      <header className="projection2d__header">
        <span className="projection2d__title">
          2D-ПРОЕКЦИЯ{clouds.length > 1 ? ` · ${clouds.length} графика рядом` : ""}
        </span>
        {loading && <span className="badge">обновление…</span>}
        <span className="projection2d__spacer" />
        <label className="projection2d__size" title="Размер точек (общий с 3D-сценой)">
          <span className="mono">размер</span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={pointSize}
            onChange={(e) => setPointSize(Number.parseInt(e.target.value, 10))}
            aria-label="Размер точек"
          />
        </label>
        <span
          className="projection2d__note"
          title="Проекция ВСЕХ точек — не математический срез исходного пространства (срезы — этап 4). Расстояния на карте приближают исходные; на UMAP — только локально. Колесо — масштаб, перетаскивание — сдвиг, Shift — выделение области."
        >
          проекция всех точек · не срез
        </span>
      </header>
      <div className="projection2d__plots">
        {clouds.map((cloud) => (
          <Plot2D key={cloud.projection.id} cloud={cloud} />
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* One plot                                                            */
/* ------------------------------------------------------------------ */

export function Plot2D({ cloud }: { cloud: PointCloud }) {
  const pointSize = useSpaceStore((s) => s.pointSize);
  const hoveredId = useSpaceStore((s) => s.hoveredId);
  const setHover = useSpaceStore((s) => s.setHover);
  const sliceOverlay = useSpaceStore((s) => s.sliceOverlay);
  const sliceDisplay = useSpaceStore((s) => s.sliceDisplay);
  const colorBy = useSpaceStore((s) => s.colorBy);
  const clusterLabels = useSpaceStore((s) => s.clusterLabels);

  const activeFragmentId = useProjectStore((s) => s.activeFragmentId);
  const selectedIds = useProjectStore((s) => s.selectedFragmentIds);
  const selectFragment = useProjectStore((s) => s.selectFragment);
  const toggleFragmentSelection = useProjectStore((s) => s.toggleFragmentSelection);
  const setSelectedFragments = useProjectStore((s) => s.setSelectedFragments);
  const clearSelection = useProjectStore((s) => s.clearSelection);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const [shiftDown, setShiftDown] = useState(false);
  /** null = auto-fit; otherwise the zoomed/panned data window. */
  const [view, setView] = useState<PlotBounds | null>(null);
  const [panning, setPanning] = useState(false);
  const [localTooltip, setLocalTooltip] = useState<{ meta: PointMeta; x: number; y: number } | null>(
    null,
  );
  const dragRef = useRef<{ x: number; y: number; mode: "pan" | "marquee"; moved: boolean } | null>(
    null,
  );

  const count = cloud.points.count;
  const fitBounds = useMemo(() => computeBounds2D(cloud.coords, count), [cloud, count]);
  const fitRef = useRef(fitBounds);
  useEffect(() => {
    fitRef.current = fitBounds;
  }, [fitBounds]);
  // Another projection in the same slot: the camera resets to auto-fit.
  useEffect(() => {
    setView(null);
  }, [cloud]);

  const bounds = view ?? fitBounds;
  const geom = useMemo<PlotGeometry>(
    () => ({ width: size.w, height: size.h, padding: PADDING, bounds }),
    [size.w, size.h, bounds],
  );
  const zoom = zoomLevel(bounds, fitBounds);

  /* Track container size (Allotment drags, window resize). */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  /* Shift arms the marquee in every 2D plot (single source: window). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftDown(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftDown(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  /* Precomputed pixel positions (hit-testing and drawing share them). */
  const pixels = useMemo(() => {
    const arr = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const { cx, cy } = dataToCanvas(cloud.coords[i * 2], cloud.coords[i * 2 + 1], geom);
      arr[i * 2] = cx;
      arr[i * 2 + 1] = cy;
    }
    return arr;
  }, [cloud, count, geom]);

  const pixelOf = useMemo(
    () => (index: number) => ({ cx: pixels[index * 2], cy: pixels[index * 2 + 1] }),
    [pixels],
  );

  /* Slice of the ORIGINAL space over this plot (only when the projection's
     embedding run matches; "dim" fades out-of-layer points, "only" hides
     them — hidden points are not hoverable/pickable/marquee-selectable). */
  const sliceMasks: CloudSliceMask | null = useMemo(() => {
    if (!sliceOverlay || sliceDisplay === "off") return null;
    if (sliceOverlay.embeddingRunId !== cloud.projection.embedding_run_id) return null;
    const ids = cloud.metas.map((m) => m.fragmentId);
    return cloudSliceMask(ids, sliceOverlay.uById, sliceOverlay);
  }, [cloud, sliceOverlay, sliceDisplay]);

  const isVisible = useMemo(() => {
    if (!sliceMasks || sliceDisplay !== "only") return null; // null = every point
    const mask = sliceMasks.mask;
    return (i: number) => mask[i] === 1;
  }, [sliceMasks, sliceDisplay]);

  const colorAt = useMemo(() => {
    if (colorBy !== "cluster" || !clusterLabels) return null;
    const labels = clusterLabels;
    return (i: number): string => {
      const label = labels.get(cloud.metas[i].fragmentId);
      if (label === undefined) return COLORS.gray;
      return label < 0 ? clusterColor(-1) : clusterColor(label);
    };
  }, [colorBy, clusterLabels, cloud]);

  /* Wheel zoom towards the cursor (native listener: React's is passive). */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((prev) => {
        const base = prev ?? fitRef.current;
        const g: PlotGeometry = {
          width: rect.width,
          height: rect.height,
          padding: PADDING,
          bounds: base,
        };
        const anchor = canvasToData(cx, cy, g);
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SPEED);
        return zoomBoundsAt(base, fitRef.current, factor, anchor);
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  /* ---------------------------- drawing ---------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom without a 2d context stub

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);

    const plotL = PADDING.left;
    const plotT = PADDING.top;
    const plotR = size.w - PADDING.right;
    const plotB = size.h - PADDING.bottom;

    /* frame + ticks (of the CURRENT view bounds — zoom changes the grid) */
    ctx.strokeStyle = "#232a31";
    ctx.lineWidth = 1;
    ctx.strokeRect(plotL + 0.5, plotT + 0.5, plotR - plotL, plotB - plotT);

    const xTicks = makeTicks(bounds.minX, bounds.maxX);
    const yTicks = makeTicks(bounds.minY, bounds.maxY);
    const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : 1;
    const yStep = yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1;
    ctx.font = "9px 'Cascadia Code', Consolas, monospace";
    ctx.fillStyle = COLORS.textDim;
    ctx.strokeStyle = COLORS.grid;
    // points outside the zoom window are clipped to the plot frame
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotT, Math.max(0, plotR - plotL), Math.max(0, plotB - plotT));
    ctx.clip();
    for (const v of xTicks) {
      const { cx } = dataToCanvas(v, bounds.minY, geom);
      ctx.beginPath();
      ctx.moveTo(cx, plotT);
      ctx.lineTo(cx, plotB);
      ctx.stroke();
    }
    for (const v of yTicks) {
      const { cy } = dataToCanvas(bounds.minX, v, geom);
      ctx.beginPath();
      ctx.moveTo(plotL, cy);
      ctx.lineTo(plotR, cy);
      ctx.stroke();
    }

    /* points: small squares (distinct from selection rings — not color-only) */
    const r = Math.max(1, pointSize * 0.7);
    // out-of-layer context pass (slice display = "dim")
    if (sliceMasks && sliceDisplay === "dim") {
      ctx.fillStyle = "#2c343c";
      for (let i = 0; i < count; i++) {
        if (sliceMasks.mask[i]) continue;
        const cx = pixels[i * 2];
        const cy = pixels[i * 2 + 1];
        if (cx < plotL - r || cx > plotR + r || cy < plotT - r || cy > plotB + r) continue;
        ctx.fillRect(cx - r / 2, cy - r / 2, r, r);
      }
    }
    for (let i = 0; i < count; i++) {
      if (isVisible && !isVisible(i)) continue;
      const cx = pixels[i * 2];
      const cy = pixels[i * 2 + 1];
      if (cx < plotL - r || cx > plotR + r || cy < plotT - r || cy > plotB + r) continue;
      ctx.fillStyle = colorAt ? colorAt(i) : kindColor(cloud.metas[i].kind);
      ctx.fillRect(cx - r / 2, cy - r / 2, r, r);
    }

    /* multi-selection: amber rings (out-of-layer points keep the selection
       in the store but show no ring — they are context, not the layer) */
    ctx.lineWidth = 1.4;
    for (const id of selectedIds) {
      const i = cloud.indexById.get(id);
      if (i === undefined) continue;
      if (isVisible && !isVisible(i)) continue;
      ctx.strokeStyle = COLORS.selected;
      ctx.beginPath();
      ctx.arc(pixels[i * 2], pixels[i * 2 + 1], r + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* active fragment: teal ring + crosshair marks (shape, not only color) */
    if (activeFragmentId !== null) {
      const i = cloud.indexById.get(activeFragmentId);
      if (i !== undefined) {
        const cx = pixels[i * 2];
        const cy = pixels[i * 2 + 1];
        ctx.strokeStyle = COLORS.active;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 4.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - r - 8, cy);
        ctx.lineTo(cx - r - 4.5, cy);
        ctx.moveTo(cx + r + 4.5, cy);
        ctx.lineTo(cx + r + 8, cy);
        ctx.stroke();
      }
    }

    /* hover: thin white ring */
    if (hoveredId) {
      const i = cloud.indexById.get(hoveredId);
      if (i !== undefined) {
        ctx.strokeStyle = COLORS.hover;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pixels[i * 2], pixels[i * 2 + 1], r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    /* tick labels (outside the clip, along the frame) */
    ctx.fillStyle = COLORS.textDim;
    ctx.strokeStyle = "#232a31";
    for (const v of xTicks) {
      const { cx } = dataToCanvas(v, bounds.minY, geom);
      if (cx < plotL - 1 || cx > plotR + 1) continue;
      ctx.textAlign = "center";
      ctx.fillText(formatTick(v, xStep), cx, size.h - PADDING.bottom + 12);
    }
    for (const v of yTicks) {
      const { cy } = dataToCanvas(bounds.minX, v, geom);
      if (cy < plotT - 1 || cy > plotB + 1) continue;
      ctx.textAlign = "right";
      ctx.fillText(formatTick(v, yStep), plotL - 5, cy + 3);
    }

    /* marquee */
    if (marquee) {
      const x = Math.min(marquee.x0, marquee.x1);
      const y = Math.min(marquee.y0, marquee.y1);
      const w = Math.abs(marquee.x1 - marquee.x0);
      const h = Math.abs(marquee.y1 - marquee.y0);
      ctx.fillStyle = "rgba(69, 214, 197, 0.07)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = COLORS.teal;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }
  }, [
    cloud,
    count,
    pixels,
    size,
    bounds,
    geom,
    pointSize,
    selectedIds,
    activeFragmentId,
    hoveredId,
    marquee,
    sliceMasks,
    sliceDisplay,
    isVisible,
    colorAt,
  ]);

  /* --------------------------- interaction -------------------------- */

  /** Pointer position in canvas pixels (jsdom-safe: clientX − bounding rect). */
  const eventPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = eventPos(e);
    const marqueeMode = shiftDown || e.shiftKey;
    dragRef.current = { x, y, mode: marqueeMode ? "marquee" : "pan", moved: false };
    if (marqueeMode) {
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
    } else {
      setPanning(true);
    }
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = eventPos(e);
    const drag = dragRef.current;
    if (drag) {
      if (Math.abs(x - drag.x) > DRAG_SLOP_PX || Math.abs(y - drag.y) > DRAG_SLOP_PX) {
        drag.moved = true;
      }
      if (drag.mode === "marquee") {
        setMarquee((prev) => (prev ? { ...prev, x1: x, y1: y } : prev));
        return;
      }
      // pan: the content follows the cursor
      if (drag.moved) {
        const dx = x - drag.x;
        const dy = y - drag.y;
        setView((prev) => panBounds(prev ?? fitRef.current, dx, dy, geom));
        drag.x = x;
        drag.y = y;
      }
      return;
    }
    const hit = hitTest2D(count, { cx: x, cy: y }, HIT_RADIUS_PX, pixelOf, isVisible);
    if (hit === null) {
      setLocalTooltip(null);
      setHover(null);
    } else {
      const meta = cloud.metas[hit];
      if (meta) {
        setLocalTooltip({ meta, x, y });
        setHover(meta.fragmentId, { kind: "2d", x, y });
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    const { x, y } = eventPos(e);
    if (drag?.mode === "marquee" && marquee) {
      if (drag.moved) {
        const a = canvasToData(Math.min(marquee.x0, marquee.x1), 0, geom);
        const b = canvasToData(Math.max(marquee.x0, marquee.x1), 0, geom);
        const c = canvasToData(0, Math.min(marquee.y0, marquee.y1), geom);
        const d = canvasToData(0, Math.max(marquee.y0, marquee.y1), geom);
        const indices = indicesInDataRect(cloud.coords, count, {
          minX: a.x,
          maxX: b.x,
          minY: d.y, // canvas y grows down → data y grows up
          maxY: c.y,
        }).filter((i) => !isVisible || isVisible(i));
        const picked = indices.map((i) => cloud.metas[i].fragmentId);
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+marquee ADDS the area to the current selection (like ctrl-click)
          const current = useProjectStore.getState().selectedFragmentIds;
          setSelectedFragments([...new Set([...current, ...picked])]);
        } else {
          setSelectedFragments(picked);
        }
      }
      // a Shift-click without a drag never touches the selection
      setMarquee(null);
      return;
    }
    if (drag?.moved) {
      return; // a pan, not a click
    }
    const hit = hitTest2D(count, { cx: x, cy: y }, HIT_RADIUS_PX, pixelOf, isVisible);
    if (hit === null) {
      clearSelection();
      return;
    }
    const meta = cloud.metas[hit];
    if (!meta) return;
    const ref = toFragmentRef(meta);
    if (e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) {
      void toggleFragmentSelection(ref);
    } else {
      void selectFragment(ref);
    }
  };

  const onPointerLeave = () => {
    setLocalTooltip(null);
    setHover(null);
    if (marquee) {
      setMarquee(null);
      dragRef.current = null;
      setPanning(false);
    }
  };

  const resetView = useCallback(() => setView(null), []);

  /* ------------------------------ render ---------------------------- */

  const projection = cloud.projection;
  const axisInfo = projection.axis_info;
  const axesLabel =
    projection.axis_labels.length >= 2
      ? `${projection.axis_labels[0]} / ${projection.axis_labels[1]}`
      : null;

  return (
    <div
      className={`plot2d${shiftDown ? " plot2d--marquee" : ""}${panning ? " plot2d--panning" : ""}`}
      aria-label={`2D-график (${projection.method_display_name})`}
    >
      <header className="plot2d__header">
        <span className="mono plot2d__method">
          {projection.method_display_name} · {count} точ.
        </span>
        {axesLabel && (
          <span className="mono plot2d__axes">
            оси: {axesLabel}
            {axisInfo && axisInfo.length >= 2
              ? ` (${Math.round(axisInfo[0] * 100)}% / ${Math.round(axisInfo[1] * 100)}% дисперсии)`
              : ""}
          </span>
        )}
        {sliceMasks && (
          <span
            className="badge"
            title="Слой выбран в ИСХОДНОМ пространстве; график показывает его через эту проекцию"
          >
            слой: {sliceMasks.inLayer} из {sliceMasks.mask.length}
          </span>
        )}
        {projection.stale && (
          <span
            className="badge badge--warn"
            title="Векторы изменились после построения — пересчитайте проекцию"
          >
            устарела
          </span>
        )}
        {cloud.points.dropped_orphans > 0 && (
          <span className="badge badge--warn">−{cloud.points.dropped_orphans} удалённых</span>
        )}
        <span className="plot2d__spacer" />
        <span className="mono plot2d__zoom" title="Масштаб относительно автоподгонки">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="btn btn--small"
          onClick={resetView}
          disabled={view === null}
          title="Сбросить масштаб и сдвиг к автоподгонке (или двойной клик)"
        >
          ⌂
        </button>
      </header>
      <div className="plot2d__canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="plot2d__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onDoubleClick={resetView}
          role="img"
          aria-label={
            axesLabel
              ? `2D-проекция (${projection.method_display_name}), оси ${axesLabel}, ${count} точек`
              : `2D-проекция (${projection.method_display_name}), ${count} точек`
          }
        />
        {localTooltip && (
          <div
            className="scene-tooltip"
            style={{ left: localTooltip.x, top: localTooltip.y }}
            role="tooltip"
          >
            <span className="scene-tooltip__kind mono">{kindBadge(localTooltip.meta.kind)}</span>
            <span className="scene-tooltip__name">
              {localTooltip.meta.name ?? localTooltip.meta.symbolPath}
            </span>
            <span className="scene-tooltip__path mono">
              {localTooltip.meta.relPath}:{localTooltip.meta.startLine}–
              {localTooltip.meta.endLine}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
