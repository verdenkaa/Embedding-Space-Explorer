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

import {
  AXIS_COLORS,
  COLORS,
  buildLegendFrom,
  hexToRgb,
  kindColor,
} from "../../space/palette";
import { toFragmentRef } from "../../space/fragmentRef";
import { marqueeNdc } from "../../space/marqueeMath";
import {
  indicesInNdcRect,
  marqueeExceedsSlop,
  normalizeRect,
  pickClosestToRay,
} from "../../space/selectionMath";
import { AXIS_HALF, FLOOR_Y, gridLabels3D } from "../../space/gridMath";
import type { FitTransform } from "../../space/selectionMath";
import { useProjectStore } from "../../state/projectStore";
import {
  useSpaceStore,
  type CloudKind,
  type GridMode,
  type PointCloud,
  type PointMeta,
} from "../../state/spaceStore";
import { kindBadge } from "../../monaco/helpers";

/** Color + legend key of one point (kind-based by default; clustering
 *  passes its own resolver — the legend always carries TEXT keys). */
export interface ColorEntry {
  key: string;
  color: string;
}

export type PointColorOf = (meta: PointMeta) => ColorEntry;

const kindColorOf: PointColorOf = (meta) => ({
  key: meta.kind,
  color: kindColor(meta.kind),
});

const DIM_COLOR = COLORS.dim;

/**
 * Shared interactive point-cloud scene behind Scene3D
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
 * - Esc / background click / toolbar button → clear.
 *
 * `mask` (4D view) hides points outside the current "time" window: hidden
 * points are not rendered and cannot be hovered/picked/marquee-selected.
 */

const HIT_THRESHOLD = 0.05; // world units; display coords live in [-1, 1]
const DRAG_SLOP_PX = 4;

/* ------------------------------------------------------------------ */
/* Static scene furniture: thin technical grid + delicate axes */
/* ------------------------------------------------------------------ */

function useGridGeometry(): THREE.BufferGeometry {
  return useMemo(() => {
    const y = FLOOR_Y;
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
    // Separate segments per axis so each gets its own color group; full span
    // (−AXIS_HALF..AXIS_HALF) so numeric ticks along an axis sit on its line.
    const h = AXIS_HALF;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [-h, 0, 0, h, 0, 0, 0, -h, 0, 0, h, 0, 0, 0, -h, 0, 0, h],
        3,
      ),
    );
    g.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(
        [
          ...hexToRgb(AXIS_COLORS[0]),
          ...hexToRgb(AXIS_COLORS[0]),
          ...hexToRgb(AXIS_COLORS[1]),
          ...hexToRgb(AXIS_COLORS[1]),
          ...hexToRgb(AXIS_COLORS[2]),
          ...hexToRgb(AXIS_COLORS[2]),
        ],
        3,
      ),
    );
    return g;
  }, []);
}

/* ------------------------------------------------------------------ */
/* Numeric grid labels (canvas-texture sprites, JetBrains Mono)         */
/* ------------------------------------------------------------------ */

/**
 * Render `text` into a small canvas and return it as a texture. Uses the
 * bundled JetBrains Mono (already loaded via @font-face), so no external
 * font is fetched. Returns null where a 2D canvas is unavailable; in jsdom the
 * whole R3F Canvas is mocked out, so this is never reached in tests.
 */
function makeTextTexture(text: string, colorHex: string): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // High-res raster: the sprite is scaled DOWN in world space, so the texture
  // stays crisp while the label itself stays small on screen.
  const font = "600 44px 'JetBrains Mono', Consolas, monospace";
  ctx.font = font;
  const pad = 10;
  const width = Math.max(24, Math.ceil(ctx.measureText(text).width) + pad * 2);
  const height = 60;
  canvas.width = width;
  canvas.height = height;
  // the 2D context state resets when the canvas is resized
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = colorHex;
  ctx.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  // canvas pixels are sRGB: tell the renderer to decode them, otherwise the
  // muted label colors wash out toward white
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** True once the bundled webfonts are usable (labels must not bake a fallback
 *  glyph shape into their texture). */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(
    () => typeof document === "undefined" || !("fonts" in document),
  );
  useEffect(() => {
    if (ready) return;
    let alive = true;
    document.fonts.ready
      .then(() => {
        if (alive) setReady(true);
      })
      .catch(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [ready]);
  return ready;
}

/** Numeric + axis-name labels along the principal axes («numbers» mode only).
 *  Sprite height is a small fraction of the [-1,1] scene so a tick never
 *  covers its neighbours; the high-res texture keeps the text crisp. */
function GridLabels({ fit, axisLabels }: { fit: FitTransform; axisLabels: string[] }) {
  const fontsReady = useFontsReady();
  const sprites = useMemo(() => {
    const built: THREE.Sprite[] = [];
    if (!fontsReady) return built; // rebuild once the real font is available
    for (const label of gridLabels3D(fit, axisLabels)) {
      const texture = makeTextTexture(
        label.text,
        label.isAxisName ? COLORS.textDim : COLORS.textFaint,
      );
      if (!texture) continue;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(label.position[0], label.position[1], label.position[2]);
      const aspect = texture.image.width / texture.image.height;
      const h = label.isAxisName ? 0.11 : 0.085;
      sprite.scale.set(h * aspect, h, 1);
      sprite.renderOrder = 20;
      sprite.raycast = () => null; // never intercept point picking
      built.push(sprite);
    }
    return built;
  }, [fit, axisLabels, fontsReady]);

  useEffect(
    () => () => {
      for (const sprite of sprites) {
        sprite.material.map?.dispose();
        sprite.material.dispose();
      }
    },
    [sprites],
  );

  return (
    <>
      {sprites.map((sprite, i) => (
        <primitive key={i} object={sprite} />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Inside the Canvas */
/* ------------------------------------------------------------------ */

interface SceneContentsProps {
  cloud: PointCloud;
  pointSize: number;
  activeFragmentId: string | null;
  selectedIds: string[];
  hoveredId: string | null;
  orbitEnabled: boolean;
  /** Coordinate-grid display mode (off / simple / numbers). */
  gridMode: GridMode;
  /** Original point indices that are currently visible (mask applied). */
  visible: Int32Array;
  /** Original indices drawn faded (context only: no hover/pick/marquee). */
  dimmed: Int32Array;
  colorOf: PointColorOf;
  lines: { positions: Float32Array; colors: Float32Array } | null;
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
  gridMode,
  visible,
  dimmed,
  colorOf,
  lines,
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

  const buildPoints = useCallback(
    (indices: Int32Array, uniformColor: string | null) => {
      const positions = new Float32Array(indices.length * 3);
      const colors = new Float32Array(indices.length * 3);
      indices.forEach((orig, slot) => {
        const color = uniformColor ?? colorOf(cloud.metas[orig]).color;
        const [r, g, b] = hexToRgb(color);
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
    },
    [cloud, colorOf],
  );

  const geometry = useMemo(() => buildPoints(visible, null), [buildPoints, visible]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const dimmedGeometry = useMemo(
    () => (dimmed.length > 0 ? buildPoints(dimmed, DIM_COLOR) : null),
    [buildPoints, dimmed],
  );
  useEffect(() => () => dimmedGeometry?.dispose(), [dimmedGeometry]);

  const linesGeometry = useMemo(() => {
    if (!lines || lines.positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(lines.positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(lines.colors, 3));
    return geo;
  }, [lines]);
  useEffect(() => () => linesGeometry?.dispose(), [linesGeometry]);

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
      {gridMode !== "off" && (
        <lineSegments geometry={gridGeometry}>
          {/* oblique 1px lines lose ~half their contrast to AA: grid3d is
              stronger than the 2D canvas grid token on purpose */}
          <lineBasicMaterial color={COLORS.grid3d} />
        </lineSegments>
      )}
      <lineSegments geometry={axesGeometry}>
        <lineBasicMaterial vertexColors transparent opacity={0.55} />
      </lineSegments>
      {gridMode === "numbers" && (
        <GridLabels fit={cloud.fit} axisLabels={cloud.projection.axis_labels} />
      )}

      <points
        geometry={geometry}
        onPointerMove={(e) => {
          e.stopPropagation();
          // the point closest to the RAY (three sorts hits by distance from
          // the camera — intersections[0] would be a foreground point that
          // merely shares the threshold tube, not the one under the cursor)
          const slot = pickClosestToRay(e.intersections)?.index;
          onHover(slot === undefined ? null : visible[slot], e);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e) => {
          e.stopPropagation();
          // R3F fires click even after an orbit drag: e.delta is the pointer
          // travel in px — a real pick requires a near-stationary click.
          if (e.delta > DRAG_SLOP_PX) return;
          const slot = pickClosestToRay(e.intersections)?.index;
          if (slot !== undefined) {
            onPick(visible[slot], e.nativeEvent.ctrlKey || e.nativeEvent.metaKey);
          }
        }}
      >
        <pointsMaterial vertexColors size={0.021 * pointSize} sizeAttenuation />
      </points>

      {dimmedGeometry && (
        <points geometry={dimmedGeometry} raycast={() => null}>
          <pointsMaterial
            vertexColors
            size={0.016 * pointSize}
            sizeAttenuation
            transparent
            opacity={0.38}
            depthWrite={false}
          />
        </points>
      )}

      {linesGeometry && (
        <lineSegments geometry={linesGeometry} raycast={() => null}>
          <lineBasicMaterial vertexColors transparent opacity={0.55} />
        </lineSegments>
      )}

      {/* Selection markers are OVERLAYS, not scene geometry: coincident depth
          with the point itself is driver-dependent, so they skip the depth
          test and draw last — a selection must always be visible. */}
      {selectedIds.length > 0 && (
        <points geometry={selectedGeometry} raycast={() => null} renderOrder={25}>
          <pointsMaterial
            color={COLORS.selected}
            size={0.034 * pointSize}
            sizeAttenuation
            depthTest={false}
            depthWrite={false}
          />
        </points>
      )}

      {activePos && (
        <Billboard position={activePos}>
          <mesh raycast={() => null} renderOrder={26}>
            <ringGeometry args={[0.032, 0.045, 40]} />
            <meshBasicMaterial
              color={COLORS.active}
              transparent
              opacity={0.95}
              depthTest={false}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        </Billboard>
      )}
      {hoverPos && (
        <Billboard position={hoverPos}>
          <mesh raycast={() => null} renderOrder={27}>
            <ringGeometry args={[0.024, 0.032, 32]} />
            <meshBasicMaterial
              color={COLORS.hover}
              transparent
              opacity={0.8}
              depthTest={false}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        </Billboard>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Component + DOM overlays */
/* ------------------------------------------------------------------ */

export interface PointSceneProps {
  cloud: PointCloud;
  /** Which tooltip channel this scene owns (hover sync between views). */
  hoverKind: Exclude<CloudKind, "2d">;
  ariaLabel: string;
  /** Identity badge content (top-left; method/axes/freshness — honesty). */
  badge: ReactNode;
  /** Bottom overlay (4D "time" panel, relation-line filters). */
  footer?: ReactNode;
  /** Extra toolbar controls (relation-lines toggle, color-mode switch). */
  toolbarExtras?: ReactNode;
  /** 1 = visible; null/undefined = every point is visible. */
  mask?: Uint8Array | null;
  /** 1 = draw faded as context (not hoverable/pickable/selectable). */
  dimMask?: Uint8Array | null;
  /** Point color + legend key resolver (default: fragment kind). */
  colorOf?: PointColorOf;
  /** Structural relation lines (pre-built segment buffers). */
  lines?: { positions: Float32Array; colors: Float32Array } | null;
  className?: string;
}

export function PointScene({
  cloud,
  hoverKind,
  ariaLabel,
  badge,
  footer,
  toolbarExtras,
  mask,
  dimMask,
  colorOf,
  lines,
  className,
}: PointSceneProps) {
  const pointSize = useSpaceStore((s) => s.pointSize);
  const gridMode = useSpaceStore((s) => s.gridMode);
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

  const dimmed = useMemo(() => {
    if (!dimMask) return new Int32Array(0);
    const list: number[] = [];
    for (let i = 0; i < dimMask.length; i++) {
      if (dimMask[i] && (!mask || mask[i])) list.push(i);
    }
    return Int32Array.from(list);
  }, [dimMask, mask]);

  const resolveColor = useMemo(() => colorOf ?? kindColorOf, [colorOf]);

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
      // points behind the camera must never be selected: the perspective
      // divide mirrors them into the NDC range (see marqueeMath)
      camera.updateMatrixWorld();
      const ndc = marqueeNdc(cloud.display, visible, camera);
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

  const legend = useMemo(() => {
    const entries = buildLegendFrom(
      Array.from(visible, (orig) => resolveColor(cloud.metas[orig]).key),
      (key) => {
        // color of a key = color of its first occurrence (deterministic)
        for (const orig of Array.from(visible)) {
          const entry = resolveColor(cloud.metas[orig]);
          if (entry.key === key) return entry.color;
        }
        return COLORS.gray;
      },
    );
    // cluster keys sort numerically («кластер 2» before «кластер 10»);
    // kind keys keep the palette order via first-seen ordering
    return entries;
  }, [cloud, visible, resolveColor]);
  const hoveredMeta = useMemo(() => {
    if (!hoveredId) return null;
    const i = cloud.indexById.get(hoveredId);
    if (i === undefined) return null;
    // a point hidden by the 4D window must not keep a floating tooltip
    if (mask && !mask[i]) return null;
    return cloud.metas[i];
  }, [cloud, hoveredId, mask]);

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
        gl={{ preserveDrawingBuffer: true }}
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
          gridMode={gridMode}
          visible={visible}
          dimmed={dimmed}
          colorOf={resolveColor}
          lines={lines ?? null}
          onHover={onHover}
          onPick={onPick}
          onCameraReady={onCameraReady}
          controlsRef={controlsRef}
        />
      </Canvas>

      {/* Projection identity badge — axes belong to the projection */}
      <div className="point-scene__badge mono">{badge}</div>

      {/* Toolbar: no mode buttons — Shift temporarily arms the marquee */}
      <div className="point-scene__toolbar" role="toolbar" aria-label="Инструменты сцены">
        <span
          className="point-scene__mode-hint"
          title="Без модификаторов — вращение камеры; удерживайте Shift и тяните, чтобы выделить область (рамка выбирает точки насквозь, включая закрытые другими); Ctrl добавляет точки/области к выделению; Esc снимает выделение"
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
        {toolbarExtras}
      </div>

      {/* Legend: color + text badge (never color-only); collapsible
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
                {colorOf === undefined && (
                  <span className="legend-item__badge mono">{kindBadge(entry.kind)}</span>
                )}
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
