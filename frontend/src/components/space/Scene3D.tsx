import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Billboard, OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { COLORS, buildLegend, hexToRgb, kindColor } from "../../space/palette";
import { toFragmentRef } from "../../space/fragmentRef";
import { indicesInNdcRect, normalizeRect } from "../../space/selectionMath";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore, type PointCloud } from "../../state/spaceStore";
import { kindBadge } from "../../monaco/helpers";

/**
 * 3D embedding space (TZ §4.3, UI-ТЗ §3): one batched THREE.Points object
 * with buffer attributes — never a React component per point. Real
 * projection coordinates come from the backend cache; the only client-side
 * math is a view-only fit into [-1, 1].
 *
 * Interactions: orbit/zoom (OrbitControls), hover tooltip, click = select
 * (ctrl/meta = toggle), marquee area selection (toolbar mode or Shift+drag),
 * Esc / background click / toolbar button clear the selection (TZ §8.3).
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
  onHover: (index: number | null, event?: ThreeEvent<PointerEvent>) => void;
  onPick: (index: number, additive: boolean) => void;
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

  const colors = useMemo(() => {
    const arr = new Float32Array(cloud.metas.length * 3);
    cloud.metas.forEach((meta, i) => {
      const [r, g, b] = hexToRgb(kindColor(meta.kind));
      arr[i * 3] = r;
      arr[i * 3 + 1] = g;
      arr[i * 3 + 2] = b;
    });
    return arr;
  }, [cloud]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(cloud.display, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  }, [cloud, colors]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const selectedGeometry = useMemo(() => {
    const positions: number[] = [];
    for (const id of selectedIds) {
      const i = cloud.indexById.get(id);
      if (i === undefined) continue;
      positions.push(cloud.display[i * 3], cloud.display[i * 3 + 1], cloud.display[i * 3 + 2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [cloud, selectedIds]);
  useEffect(() => () => selectedGeometry.dispose(), [selectedGeometry]);

  const markerAt = useCallback(
    (id: string | null): [number, number, number] | null => {
      if (!id) return null;
      const i = cloud.indexById.get(id);
      if (i === undefined) return null;
      return [cloud.display[i * 3], cloud.display[i * 3 + 1], cloud.display[i * 3 + 2]];
    },
    [cloud],
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
          const index = e.intersections[0]?.index;
          onHover(index === undefined ? null : index, e);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e) => {
          e.stopPropagation();
          const index = e.intersections[0]?.index;
          if (index !== undefined) {
            onPick(index, e.nativeEvent.ctrlKey || e.nativeEvent.metaKey);
          }
        }}
      >
        <pointsMaterial
          vertexColors
          size={0.014 * pointSize}
          sizeAttenuation
          transparent
          opacity={0.92}
          depthWrite={false}
        />
      </points>

      {selectedIds.length > 0 && (
        <points geometry={selectedGeometry} raycast={() => null}>
          <pointsMaterial
            color={COLORS.selected}
            size={0.03 * pointSize}
            sizeAttenuation
            transparent
            opacity={0.9}
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

export function Scene3D() {
  const cloud = useSpaceStore((s) => s.cloud3d);
  const loading = useSpaceStore((s) => s.loading3d);
  const error = useSpaceStore((s) => s.error);
  const interactionMode = useSpaceStore((s) => s.interactionMode);
  const pointSize = useSpaceStore((s) => s.pointSize);
  const hoveredId = useSpaceStore((s) => s.hoveredId);
  const hoverScreen = useSpaceStore((s) => s.hoverScreen);
  const setHover = useSpaceStore((s) => s.setHover);
  const setInteractionMode = useSpaceStore((s) => s.setInteractionMode);
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
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  const marqueeArmed = interactionMode === "marquee" || shiftDown;

  /* Esc clears selection; Shift arms the marquee in orbit mode. */
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

  const onCameraReady = useCallback((camera: THREE.Camera) => {
    cameraRef.current = camera;
  }, []);

  const onHover = useCallback(
    (index: number | null, event?: ThreeEvent<PointerEvent>) => {
      if (index === null || !cloud || !event) {
        setHover(null);
        return;
      }
      const meta = cloud.metas[index];
      if (!meta) {
        setHover(null);
        return;
      }
      const native = event.nativeEvent;
      const rect = containerRef.current?.getBoundingClientRect();
      setHover(meta.fragmentId, {
        kind: "3d",
        x: native.clientX - (rect?.left ?? 0),
        y: native.clientY - (rect?.top ?? 0),
      });
    },
    [cloud, setHover],
  );

  const onPick = useCallback(
    (index: number, additive: boolean) => {
      const meta = cloud?.metas[index];
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
    (rectPx: { x0: number; y0: number; x1: number; y1: number }) => {
      const container = containerRef.current;
      const camera = cameraRef.current;
      if (!container || !camera || !cloud) return;
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
      const ndc = new Float32Array(cloud.metas.length * 2);
      for (let i = 0; i < cloud.metas.length; i++) {
        v.set(cloud.display[i * 3], cloud.display[i * 3 + 1], cloud.display[i * 3 + 2]);
        v.project(camera);
        ndc[i * 2] = v.x;
        ndc[i * 2 + 1] = v.y;
      }
      const indices = indicesInNdcRect(ndc, ndcRect);
      setSelectedFragments(indices.map((i) => cloud.metas[i].fragmentId));
    },
    [cloud, setSelectedFragments],
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

  const onContainerPointerUp = () => {
    if (marquee) {
      finishMarquee(marquee);
      setMarquee(null);
    }
    dragStartRef.current = null;
  };

  const legend = useMemo(
    () => (cloud ? buildLegend(cloud.metas.map((m) => m.kind)) : []),
    [cloud],
  );
  const hoveredMeta = useMemo(() => {
    if (!cloud || !hoveredId) return null;
    const i = cloud.indexById.get(hoveredId);
    return i === undefined ? null : cloud.metas[i];
  }, [cloud, hoveredId]);

  /* -------- states: loading / error / empty (honest, TZ §12) -------- */

  if (!cloud && loading) {
    return (
      <div className="scene3d scene3d--state" role="status">
        <div className="empty-hint empty-hint--center">Загрузка координат проекции…</div>
      </div>
    );
  }
  if (!cloud && error) {
    return (
      <div className="scene3d scene3d--state" role="alert">
        <div className="workspace-error">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
        </div>
      </div>
    );
  }
  if (!cloud) {
    return (
      <div className="scene3d scene3d--state">
        <div className="empty-hint empty-hint--center empty-hint--accent">
          3D-пространство пусто. Постройте проекцию на панели ниже (метод, seed,
          «Построить проекцию»); координаты будут получены из сохранённых
          эмбеддингов. Если векторов ещё нет — сначала рассчитайте их в разделе
          EXPERIMENTS.
        </div>
      </div>
    );
  }

  const projection = cloud.projection;

  return (
    <div
      className={`scene3d${hoveredMeta ? " scene3d--hover" : ""}${marqueeArmed ? " scene3d--marquee" : ""}`}
      ref={containerRef}
      onPointerDown={onContainerPointerDown}
      onPointerMove={onContainerPointerMove}
      onPointerUp={onContainerPointerUp}
      aria-label="3D embedding-пространство (проекция)"
    >
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [1.9, 1.35, 1.9], fov: 50, near: 0.01, far: 60 }}
        onCreated={({ raycaster, gl }) => {
          raycaster.params.Points.threshold = HIT_THRESHOLD;
          gl.setClearColor(COLORS.bg);
        }}
        onPointerMissed={(e) => {
          if (e.type === "click" && !draggedRef.current) {
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
          onHover={onHover}
          onPick={onPick}
          onCameraReady={onCameraReady}
          controlsRef={controlsRef}
        />
      </Canvas>

      {/* Projection identity badge — axes belong to the projection (TZ §5.2) */}
      <div className="scene3d__badge mono" title={`Запуск ${projection.id}`}>
        {projection.method_display_name} · 3D · {cloud.points.count} точек
        {projection.stale && <span className="badge badge--warn"> устарела</span>}
        {!projection.stale && <span className="badge"> свежая</span>}
      </div>

      {/* Toolbar */}
      <div className="scene3d__toolbar" role="toolbar" aria-label="Инструменты 3D-сцены">
        <button
          type="button"
          className={`btn btn--small${interactionMode === "orbit" ? " btn--primary" : ""}`}
          onClick={() => setInteractionMode("orbit")}
          title="Вращение и масштабирование камерой"
          aria-pressed={interactionMode === "orbit"}
        >
          ⟲ Орбита
        </button>
        <button
          type="button"
          className={`btn btn--small${interactionMode === "marquee" ? " btn--primary" : ""}`}
          onClick={() => setInteractionMode("marquee")}
          title="Выделение области прямоугольником (или удерживайте Shift)"
          aria-pressed={interactionMode === "marquee"}
        >
          ▭ Область
        </button>
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
        <label className="scene3d__size" title="Размер точек">
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

      {/* Legend: color + text badge (never color-only, TZ §4.1) */}
      <div className="scene3d__legend" aria-label="Легенда: цвет по типу фрагмента">
        {legend.map((entry) => (
          <span key={entry.kind} className="legend-item" title={`${entry.count} фрагментов`}>
            <span className="legend-item__dot" style={{ background: entry.color }} aria-hidden="true" />
            <span className="legend-item__badge mono">{kindBadge(entry.kind)}</span>
            <span className="mono">{entry.kind}</span>
            <span className="legend-item__count mono">{entry.count}</span>
          </span>
        ))}
      </div>

      {/* Hover tooltip */}
      {hoveredMeta && hoverScreen?.kind === "3d" && (
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
    </div>
  );
}
