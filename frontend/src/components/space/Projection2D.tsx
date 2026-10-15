import { useEffect, useMemo, useRef, useState } from "react";

import { COLORS, kindColor } from "../../space/palette";
import {
  DEFAULT_PADDING,
  canvasToData,
  computeBounds2D,
  dataToCanvas,
  formatTick,
  hitTest2D,
  indicesInDataRect,
  makeTicks,
  type PlotGeometry,
} from "../../space/selectionMath";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";
import { kindBadge } from "../../monaco/helpers";
import { toFragmentRef } from "../../space/fragmentRef";

/**
 * Synchronized 2D projection (TZ §4.4, UI-ТЗ §3): the same fragments as the
 * 3D scene, sharing the selection state by fragment id. Plain canvas 2D —
 * no per-point components; redraws happen only on state changes.
 *
 * Honesty (TZ §5.2/§5.4): the header names the projection method and its
 * axes, shows PCA explained variance when available, and states that this
 * map is a PROJECTION of all points — not a mathematical slice of the
 * original space (slices arrive at stage 4 and will be labeled separately).
 */

const PADDING = DEFAULT_PADDING;
const HIT_RADIUS_PX = 7;
const DRAG_SLOP_PX = 4;

interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function Projection2D() {
  const cloud = useSpaceStore((s) => s.cloud2d);
  const loading = useSpaceStore((s) => s.loading2d);
  const pointSize = useSpaceStore((s) => s.pointSize);
  const interactionMode = useSpaceStore((s) => s.interactionMode);
  const hoveredId = useSpaceStore((s) => s.hoveredId);
  const hoverScreen = useSpaceStore((s) => s.hoverScreen);
  const setHover = useSpaceStore((s) => s.setHover);

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
  const dragRef = useRef<{ x: number; y: number; marquee: boolean } | null>(null);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
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
  }, [clearSelection]);

  const count = cloud?.points.count ?? 0;
  const bounds = useMemo(
    () => computeBounds2D(cloud?.coords ?? new Float32Array(0), count),
    [cloud, count],
  );
  const geom = useMemo<PlotGeometry>(
    () => ({ width: size.w, height: size.h, padding: PADDING, bounds }),
    [size.w, size.h, bounds],
  );

  /* Precomputed pixel positions (hit-testing and drawing share them). */
  const pixels = useMemo(() => {
    const arr = new Float32Array(count * 2);
    if (!cloud) return arr;
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

    /* frame + ticks */
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
    for (const v of xTicks) {
      const { cx } = dataToCanvas(v, bounds.minY, geom);
      if (cx < plotL - 1 || cx > plotR + 1) continue;
      ctx.beginPath();
      ctx.moveTo(cx, plotT);
      ctx.lineTo(cx, plotB);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(formatTick(v, xStep), cx, size.h - PADDING.bottom + 12);
    }
    for (const v of yTicks) {
      const { cy } = dataToCanvas(bounds.minX, v, geom);
      if (cy < plotT - 1 || cy > plotB + 1) continue;
      ctx.beginPath();
      ctx.moveTo(plotL, cy);
      ctx.lineTo(plotR, cy);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(formatTick(v, yStep), plotL - 5, cy + 3);
    }

    if (!cloud) return;

    /* points: small squares (distinct from selection rings — not color-only) */
    const r = Math.max(1, pointSize * 0.7);
    for (let i = 0; i < count; i++) {
      const cx = pixels[i * 2];
      const cy = pixels[i * 2 + 1];
      ctx.fillStyle = kindColor(cloud.metas[i].kind);
      ctx.fillRect(cx - r / 2, cy - r / 2, r, r);
    }

    /* multi-selection: amber rings */
    ctx.lineWidth = 1.4;
    for (const id of selectedIds) {
      const i = cloud.indexById.get(id);
      if (i === undefined) continue;
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
  ]);

  /* --------------------------- interaction -------------------------- */

  const marqueeArmed = interactionMode === "marquee" || shiftDown;

  /** Pointer position in canvas pixels (jsdom-safe: clientX − bounding rect). */
  const eventPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = eventPos(e);
    const armed = marqueeArmed || e.shiftKey;
    dragRef.current = { x, y, marquee: armed };
    if (armed) {
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = eventPos(e);
    const drag = dragRef.current;
    if (drag?.marquee) {
      setMarquee((prev) => (prev ? { ...prev, x1: x, y1: y } : prev));
      return;
    }
    const hit = hitTest2D(count, { cx: x, cy: y }, HIT_RADIUS_PX, pixelOf);
    if (hit === null) {
      setHover(null);
    } else {
      const meta = cloud?.metas[hit];
      if (meta) setHover(meta.fragmentId, { kind: "2d", x, y });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    const { x, y } = eventPos(e);
    if (drag?.marquee && marquee) {
      const moved = Math.abs(x - drag.x) > DRAG_SLOP_PX || Math.abs(y - drag.y) > DRAG_SLOP_PX;
      if (moved && cloud) {
        const a = canvasToData(Math.min(marquee.x0, marquee.x1), 0, geom);
        const b = canvasToData(Math.max(marquee.x0, marquee.x1), 0, geom);
        const c = canvasToData(0, Math.min(marquee.y0, marquee.y1), geom);
        const d = canvasToData(0, Math.max(marquee.y0, marquee.y1), geom);
        const indices = indicesInDataRect(cloud.coords, count, {
          minX: a.x,
          maxX: b.x,
          minY: d.y, // canvas y grows down → data y grows up
          maxY: c.y,
        });
        const picked = indices.map((i) => cloud.metas[i].fragmentId);
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+marquee ADDS the area to the current selection (like ctrl-click)
          const current = useProjectStore.getState().selectedFragmentIds;
          setSelectedFragments([...new Set([...current, ...picked])]);
        } else {
          setSelectedFragments(picked);
        }
      }
      setMarquee(null);
      return;
    }
    if (drag && (Math.abs(x - drag.x) > DRAG_SLOP_PX || Math.abs(y - drag.y) > DRAG_SLOP_PX)) {
      return; // a drag, not a click
    }
    const hit = hitTest2D(count, { cx: x, cy: y }, HIT_RADIUS_PX, pixelOf);
    if (hit === null) {
      clearSelection();
      return;
    }
    const meta = cloud?.metas[hit];
    if (!meta) return;
    const ref = toFragmentRef(meta);
    if (e.nativeEvent.ctrlKey || e.nativeEvent.metaKey) {
      void toggleFragmentSelection(ref);
    } else {
      void selectFragment(ref);
    }
  };

  const onPointerLeave = () => {
    setHover(null);
    if (marquee) {
      setMarquee(null);
      dragRef.current = null;
    }
  };

  /* ------------------------------ render ---------------------------- */

  const hoveredMeta = useMemo(() => {
    if (!cloud || !hoveredId) return null;
    const i = cloud.indexById.get(hoveredId);
    return i === undefined ? null : cloud.metas[i];
  }, [cloud, hoveredId]);

  const projection = cloud?.projection ?? null;
  const axisInfo = projection?.axis_info;

  return (
    <section className="projection2d" aria-label="2D-проекция">
      <header className="projection2d__header">
        <span className="projection2d__title">2D-ПРОЕКЦИЯ</span>
        {projection ? (
          <>
            <span className="mono">
              {projection.method_display_name} · {count} точек
            </span>
            {projection.axis_labels.length >= 2 && (
              <span className="mono projection2d__axes">
                оси: {projection.axis_labels[0]} / {projection.axis_labels[1]}
                {axisInfo && axisInfo.length >= 2
                  ? ` (${Math.round(axisInfo[0] * 100)}% / ${Math.round(axisInfo[1] * 100)}% дисперсии)`
                  : ""}
              </span>
            )}
            {projection.stale && (
              <span className="badge badge--warn" title="Векторы изменились после построения — пересчитайте проекцию">
                устарела
              </span>
            )}
            {cloud && cloud.points.dropped_orphans > 0 && (
              <span className="badge badge--warn">
                −{cloud.points.dropped_orphans} удалённых фрагментов
              </span>
            )}
          </>
        ) : (
          <span className="projection2d__axes">нет данных</span>
        )}
        <span className="projection2d__spacer" />
        <span className="projection2d__note" title="Проекция ВСЕХ точек — не математический срез исходного пространства (срезы — этап 4). Расстояния на карте приближают исходные; на UMAP — только локально.">
          проекция всех точек · не срез
        </span>
      </header>
      <div className="projection2d__canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="projection2d__canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          role="img"
          aria-label={
            projection
              ? `2D-проекция (${projection.method_display_name}), ${count} точек`
              : "2D-проекция (нет данных)"
          }
        />
        {!cloud && loading && (
          <div className="projection2d__overlay empty-hint">Загрузка 2D-проекции…</div>
        )}
        {!cloud && !loading && (
          <div className="projection2d__overlay empty-hint">
            2D-проекция появится вместе с 3D-пространством после «Построить проекцию».
          </div>
        )}
        {hoveredMeta && hoverScreen?.kind === "2d" && (
          <div
            className="scene-tooltip"
            style={{ left: hoverScreen.x, top: hoverScreen.y }}
            role="tooltip"
          >
            <span className="scene-tooltip__kind mono">{kindBadge(hoveredMeta.kind)}</span>
            <span className="scene-tooltip__name">{hoveredMeta.name ?? hoveredMeta.symbolPath}</span>
            <span className="scene-tooltip__path mono">
              {hoveredMeta.relPath}:{hoveredMeta.startLine}–{hoveredMeta.endLine}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
