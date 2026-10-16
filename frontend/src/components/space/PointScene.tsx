import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Billboard, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as THREE from "three";

import { COLORS, buildLegend, hexToRgb, kindColor } from "../../space/palette";
import { toFragmentRef } from "../../space/fragmentRef";
import { indicesInNdcRect, marqueeExceedsSlop, normalizeRect } from "../../space/selectionMath";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore, type CloudKind, type PointCloud } from "../../state/spaceStore";
import { kindBadge } from "../../monaco/helpers";

/**
 * Shared interactive point-cloud scene (TZ §4.3, UI-ТЗ §3) behind Scene3D
 * and Scene4D: one batched THREE.Points object with buffer attributes —
 * never a React component per point. Real projection coordinates come from
 * the backend cache; the only client-side math is a view-only fit.
 *
 * Interaction model (by user feedback — no explicit mode buttons):
 * - LMB drag            → orbit the camera;
 * - Shift (hold) + drag → marquee area selection (orbit paused meanwhile);
 * - click a point       → select it (open the source);
 * - Ctrl/Cmd + click    → toggle one point in/out of the selection;
 * - Ctrl/Cmd + marquee  → ADD the area to the current selection;
 * - Esc / background click / toolbar button → clear (TZ §8.3).
 *
 * `mask` (4D view) hides points outside the current "time" window: hidden
 * points are not rendered and cannot be hovered/picked/marquee-selected.
 */

const HIT_THRESHOLD = 0.05; // world units; display coords live in [-1, 1]
const DRAG_SLOP_PX = 4;

/* ------------------------------------------------------------------ */
/* Static scene furniture: thin technical grid + delicate axes          */
/* ------------------------------------------------------------------ */

function useGridGeometry(): THREE.BufferGeometry {
  return useMemo(() => {
    const y = -1.12;
    const verts: number[] = [];
    for (let i = -4; i <= 4; i++) {
      const v = i * 0.25;
      verts.push(-1, y, v, 1, y, v);
      verts.push(v, y, -1, v, y, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, []);
}

function useAxesGeometry(): THREE.BufferGeometry {
  return useMemo(() => {
    // Separate segments per axis so each gets its own color group.
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [0, 0, 0, 1.15, 0, 0, 0, 0, 0, 0, 1.15, 0, 0, 0, 0, 0, 0, 1.15],
        3,
      ),
    );
    g.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        [
          ...hexToRgb(COLORS.teal),
          ...hexToRgb(COLORS.teal),
          ...hexToRgb(COLORS.blue),
          ...hexToRgb(COLORS.blue),
          ...hexToRgb(COLORS.amber),
          ...hexToRgb(COLORS.amber),
        ],
        3,
      ),
    );
    return g;
  }, []);
}

/* ------------------------------------------------------------------ */
/* Inside the Canvas                                                   */
/* ------------------------------------------------------------------ */

interface SceneContentsProps {
  cloud: PointCloud;
  pointSize: number;
  activeFragmentId: string | null;
  selectedIds: string[];
  hoveredId: string | null;
  orbitEnabled: boolean;
  /** Original point indices that are currently visible (mask applied). */
  visible: Int32Array;
  onHover: (originalIndex: number | null, event?: ThreeEvent<PointerEvent>) => void;
  onPick: (originalIndex: number, additive: boolean) => void;
  onCameraReady: (camera: THREE.Camera) => void;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

function SceneContents({
  cloud,
  pointSize,
  activeFragmentId,
  selectedIds,
  hoveredId,
  orbitEnabled,
  visible,
  onHover,
  onPick,
  onCameraReady,
  controlsRef,
}: SceneContentsProps) {
  const { camera } = useThree();
  const gridGeometry = useGridGeometry();
  const axesGeometry = useAxesGeometry();

  useEffect(() => {
    onCameraReady(camera);
  }, [camera, onCameraReady]);

  const geometry = useMemo(() => {
    const positions = new Float32Array(visible.length * 3);
    const colors = new Float32Array(visible.length * 3);
    visible.forEach((orig, slot) => {
      const [r, g, b] = hexToRgb(kindColor(cloud.metas[orig].kind));
      positions[slot * 3] = cloud.display[orig * 3];
      positions[slot * 3 + 1] = cloud.display[orig * 3 + 1];
      positions[slot * 3 + 2] = cloud.display[orig * 3 + 2];
      colors[slot * 3] = r;
      colors[slot * 3 + 1] = g;
      colors[slot * 3 + 2] = b;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [cloud, visible]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const visibleSet = useMemo(() => new Set(visible), [visible]);

  const selectedGeometry = useMemo(() => {
    const positions: number[] = [];
    for (const id of selectedIds) {
      const i = cloud.indexById.get(id);
      if (i === undefined || !visibleSet.has(i)) continue;
      positions.push(cloud.display[i * 3], cloud.display[i * 3 + 1], cloud.display[i * 3 + 2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [cloud, selectedIds, visibleSet]);
  useEffect(() => () => selectedGeometry.dispose(), [selectedGeometry]);

  const markerAt = useCallback(
    (id: string | null): [number, number, number] | null => {
      if (!id) return null;
      const i = cloud.indexById.get(id);
      if (i === undefined || !visibleSet.has(i)) return null;
      return [cloud.display[i * 3], cloud.display[i * 3 + 1], cloud.display[i * 3 + 2]];
    },
    [cloud, visibleSet],
  );
  const activePos = markerAt(activeFragmentId);
  const hoverPos = markerAt(hoveredId);

  return (
    <>
      <OrbitControls
        ref={controlsRef}
        enabled={orbitEnabled}
        enableDamping
        dampingFactor={0.14}
        rotateSpeed={0.7}
        zoomSpeed={0.8}
        minDistance={0.35}
        maxDistance={14}
        makeDefault
      />
      <lineSegments geometry={gridGeometry}>
        <lineBasicMaterial color="#22303a" transparent opacity={0.55} />
      </lineSegments>
      <lineSegments geometry={axesGeometry}>
        <lineBasicMaterial vertexColors transparent opacity={0.4} />
      </lineSegments>

      <points
        geometry={geometry}
        onPointerMove={(e) => {
          e.stopPropagation();
          const slot = e.intersections[0]?.index;
          onHover(slot === undefined ? null : visible[slot], e);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e) => {
          e.stopPropagation();
          // R3F fires click even after an orbit drag: e.delta is the pointer
          // travel in px — a real pick requires a near-stationary click.
          if (e.delta > DRAG_SLOP_PX) return;
          const slot = e.intersections[0]?.index;
          if (slot !== undefined) {
            onPick(visible[slot], e.nativeEvent.ctrlKey || e.nativeEvent.metaKey);
          }
        }}
      >
        <pointsMaterial vertexColors size={0.021 * pointSize} sizeAttenuation />
      </points>

      {selectedIds.length > 0 && (
        <points geometry={selectedGeometry} raycast={() => null}>
          <pointsMaterial
            color={COLORS.selected}
            size={0.034 * pointSize}
            sizeAttenuation
            depthWrite={false}
          />
        </points>
      )}

      {activePos && (
        <Billboard position={activePos}>
          <mesh raycast={() => null}>
            <ringGeometry args={[0.032, 0.045, 40]} />
            <meshBasicMaterial color={COLORS.active} transparent opacity={0.95} side={THREE.DoubleSide} />
          </mesh>
        </Billboard>
      )}
      {hoverPos && (
        <Billboard position={hoverPos}>
          <mesh raycast={() => null}>
            <ringGeometry args={[0.024, 0.032, 32]} />
            <meshBasicMaterial color={COLORS.hover} transparent opacity={0.8} side={THREE.DoubleSide} />
          </mesh>
        </Billboard>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Component + DOM overlays                                            */
/* ------------------------------------------------------------------ */

export interface PointSceneProps {
  cloud: PointCloud;
  /** Which tooltip channel this scene owns (hover sync between views). */
  hoverKind: Exclude<CloudKind, "2d">;
  ariaLabel: string;
  /** Identity badge content (top-left; method/axes/freshness — honesty). */
  badge: ReactNode;
  /** Bottom overlay (4D "time" panel). */
  footer?: ReactNode;
  /** 1 = visible; null/undefined = every point is visible. */
  mask?: Uint8Array | null;
  className?: string;
}

export function PointScene({
  cloud,
  hoverKind,
  ariaLabel,
  badge,
  footer,
  mask,
  className,
}: PointSceneProps) {
  const pointSize = useSpaceStore((s) => s.pointSize);
  const hoveredId = useSpaceStore((s) => s.hoveredId);
  const hoverScreen = useSpaceStore((s) => s.hoverScreen);
  const setHover = useSpaceStore((s) => s.setHover);
  const setPointSize = useSpaceStore((s) => s.setPointSize);

  const activeFragmentId = useProjectStore((s) => s.activeFragmentId);
  const selectedIds = useProjectStore((s) => s.selectedFragmentIds);
  const selectFragment = useProjectStore((s) => s.selectFragment);
  const toggleFragmentSelection = useProjectStore((s) => s.toggleFragmentSelection);
  const setSelectedFragments = useProjectStore((s) => s.setSelectedFragments);
  const clearSelection = useProjectStore((s) => s.clearSelection);

  const containerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);
  const [shiftDown, setShiftDown] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  /* Marquee is armed ONLY while Shift is held (no explicit mode buttons —
     user feedback): releasing Shift returns to orbiting naturally, and the
     selection survives because nothing is re-armed on the way. */
  const marqueeArmed = shiftDown;

  /* Esc clears selection; Shift arms the marquee. */
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

  const visible = useMemo(() => {
    const count = cloud.metas.length;
    if (!mask) {
      const all = new Int32Array(count);
      for (let i = 0; i < count; i++) all[i] = i;
      return all;
    }
    const list: number[] = [];
    for (let i = 0; i < count; i++) {
      if (mask[i]) list.push(i);
    }
    return Int32Array.from(list);
  }, [cloud, mask]);

  const onCameraReady = useCallback((camera: THREE.Camera) => {
    cameraRef.current = camera;
  }, []);

  const onHover = useCallback(
    (originalIndex: number | null, event?: ThreeEvent<PointerEvent>) => {
      if (originalIndex === null || !event) {
        setHover(null);
        return;
      }
      const meta = cloud.metas[originalIndex];
      if (!meta) {
        setHover(null);
        return;
      }
      const native = event.nativeEvent;
      const rect = containerRef.current?.getBoundingClientRect();
      setHover(meta.fragmentId, {
        kind: hoverKind,
        x: native.clientX - (rect?.left ?? 0),
        y: native.clientY - (rect?.top ?? 0),
      });
    },
    [cloud, hoverKind, setHover],
  );

  const onPick = useCallback(
    (originalIndex: number, additive: boolean) => {
      const meta = cloud.metas[originalIndex];
      if (!meta) return;
      const ref = toFragmentRef(meta);
      if (additive) {
        void toggleFragmentSelection(ref);
      } else {
        void selectFragment(ref);
      }
    },
    [cloud, selectFragment, toggleFragmentSelection],
  );

  /* Marquee: container-level pointer tracking (the rect DOM overlay lives
     outside the Canvas; selection math projects points with the camera). */
  const finishMarquee = useCallback(
    (rectPx: { x0: number; y0: number; x1: number; y1: number }, additive: boolean) => {
      const container = containerRef.current;
      const camera = cameraRef.current;
      if (!container || !camera) return;
      // A click (no real drag) must never change the selection — this is the
      // regression that used to wipe it when leaving the marquee mode.
      if (!marqueeExceedsSlop(rectPx, DRAG_SLOP_PX)) return;
      const width = container.clientWidth || 1;
      const height = container.clientHeight || 1;
      const rect = normalizeRect(rectPx);
      // px → NDC (y flips)
      const toNdcX = (px: number) => (px / width) * 2 - 1;
      const toNdcY = (py: number) => 1 - (py / height) * 2;
      const ndcRect = normalizeRect({
        x0: toNdcX(rect.x0),
        y0: toNdcY(rect.y0),
        x1: toNdcX(rect.x1),
        y1: toNdcY(rect.y1),
      });
      const v = new THREE.Vector3();
      const ndc = new Float32Array(visible.length * 2);
      visible.forEach((orig, slot) => {
        v.set(
          cloud.display[orig * 3],
          cloud.display[orig * 3 + 1],
          cloud.display[orig * 3 + 2],
        );
        v.project(camera);
        ndc[slot * 2] = v.x;
        ndc[slot * 2 + 1] = v.y;
      });
      const slots = indicesInNdcRect(ndc, ndcRect);
      const picked = slots.map((slot) => cloud.metas[visible[slot]].fragmentId);
      if (additive) {
        const current = useProjectStore.getState().selectedFragmentIds;
        setSelectedFragments([...new Set([...current, ...picked])]);
      } else {
        setSelectedFragments(picked);
      }
    },
    [cloud, visible, setSelectedFragments],
  );

  const onContainerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const x = rect ? e.clientX - rect.left : e.clientX;
    const y = rect ? e.clientY - rect.top : e.clientY;
    dragStartRef.current = { x, y };
    draggedRef.current = false;
    if (marqueeArmed || e.shiftKey) {
      setMarquee({ x0: x, y0: y, x1: x, y1: y });
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  };

  const onContainerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const x = rect ? e.clientX - rect.left : e.clientX;
    const y = rect ? e.clientY - rect.top : e.clientY;
    if (Math.abs(x - start.x) > DRAG_SLOP_PX || Math.abs(y - start.y) > DRAG_SLOP_PX) {
      draggedRef.current = true;
    }
    if (marquee) {
      setMarquee({ ...marquee, x1: x, y1: y });
    }
  };

  const onContainerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (marquee) {
      finishMarquee(marquee, e.ctrlKey || e.metaKey);
      setMarquee(null);
    }
    dragStartRef.current = null;
  };

  const legend = useMemo(
    () => buildLegend(Array.from(visible, (orig) => cloud.metas[orig].kind)),
    [cloud, visible],
  );
  const hoveredMeta = useMemo(() => {
    if (!hoveredId) return null;
    const i = cloud.indexById.get(hoveredId);
    return i === undefined ? null : cloud.metas[i];
  }, [cloud, hoveredId]);

  return (
    <div
      className={`point-scene${hoveredMeta ? " point-scene--hover" : ""}${
        marqueeArmed ? " point-scene--marquee" : ""
      }${className ? ` ${className}` : ""}`}
      ref={containerRef}
      onPointerDown={onContainerPointerDown}
      onPointerMove={onContainerPointerMove}
      onPointerUp={onContainerPointerUp}
      aria-label={ariaLabel}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [1.9, 1.35, 1.9], fov: 50, near: 0.01, far: 60 }}
        onCreated={({ raycaster, gl }) => {
          raycaster.params.Points.threshold = HIT_THRESHOLD;
          gl.setClearColor(COLORS.bg);
        }}
        onPointerMissed={(e) => {
          // A stationary background click clears; Shift (selection mode) and
          // orbit drags must not touch the selection.
          if (e.type === "click" && !draggedRef.current && !shiftDown) {
            clearSelection();
          }
        }}
      >
        <SceneContents
          cloud={cloud}
          pointSize={pointSize}
          activeFragmentId={activeFragmentId}
          selectedIds={selectedIds}
          hoveredId={hoveredId}
          orbitEnabled={!marqueeArmed && !marquee}
          visible={visible}
          onHover={onHover}
          onPick={onPick}
          onCameraReady={onCameraReady}
          controlsRef={controlsRef}
        />
      </Canvas>

      {/* Projection identity badge — axes belong to the projection (TZ §5.2) */}
      <div className="point-scene__badge mono">{badge}</div>

      {/* Toolbar: no mode buttons — Shift temporarily arms the marquee */}
      <div className="point-scene__toolbar" role="toolbar" aria-label="Инструменты сцены">
        <span
          className="point-scene__mode-hint"
          title="Без модификаторов — вращение камеры; удерживайте Shift и тяните, чтобы выделить область; Ctrl добавляет точки/области к выделению; Esc снимает выделение"
        >
          Shift — область · Ctrl — точка
        </span>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => controlsRef.current?.reset()}
          title="Вернуть камеру в исходное положение"
        >
          ⌂ Сброс вида
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => clearSelection()}
          disabled={selectedIds.length === 0 && activeFragmentId === null}
          title="Снять выделение (Esc)"
        >
          ✕ Снять выделение{selectedIds.length > 1 ? ` (${selectedIds.length})` : ""}
        </button>
        <label className="point-scene__size" title="Размер точек">
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
      </div>

      {/* Legend: color + text badge (never color-only, TZ §4.1); collapsible
          and scrollable so many kinds can never cover the scene */}
      <div className="point-scene__legend" aria-label="Легенда: цвет по типу фрагмента">
        <button
          type="button"
          className="point-scene__legend-toggle"
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
          title="Свернуть/развернуть легенду"
        >
          Легенда · {legend.length} {legendOpen ? "▾" : "▸"}
        </button>
        {legendOpen && (
          <div className="point-scene__legend-items">
            {legend.map((entry) => (
              <span key={entry.kind} className="legend-item" title={`${entry.count} фрагментов`}>
                <span
                  className="legend-item__dot"
                  style={{ background: entry.color }}
                  aria-hidden="true"
                />
                <span className="legend-item__badge mono">{kindBadge(entry.kind)}</span>
                <span className="mono">{entry.kind}</span>
                <span className="legend-item__count mono">{entry.count}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Hover tooltip */}
      {hoveredMeta && hoverScreen?.kind === hoverKind && (
        <div
          className="scene-tooltip"
          style={{ left: hoverScreen.x, top: hoverScreen.y }}
          role="tooltip"
        >
          <span className="scene-tooltip__kind mono">{kindBadge(hoveredMeta.kind)}</span>
          <span className="scene-tooltip__name">{hoveredMeta.name ?? hoveredMeta.symbolPath}</span>
          <span className="scene-tooltip__path mono" title={hoveredMeta.relPath}>
            {hoveredMeta.relPath}:{hoveredMeta.startLine}–{hoveredMeta.endLine}
          </span>
        </div>
      )}

      {/* Marquee rectangle */}
      {marquee && (
        <div
          className="marquee-rect"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
          aria-hidden="true"
        />
      )}

      {footer}
    </div>
  );
}
