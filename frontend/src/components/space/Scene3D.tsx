import { useEffect, useMemo, useState } from "react";

import { hexToRgb } from "../../space/palette";
import { RELATION_LINE_LIMIT, relationColor } from "../../space/relationLabels";
import { sliceMasksForCloud } from "../../space/sliceMath";
import { makeClusterColorOf } from "../../space/clusterColor";
import { useAnalysisStore } from "../../state/analysisStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore } from "../../state/spaceStore";
import { PointScene, type PointColorOf } from "./PointScene";

/**
 * 3D embedding space (TZ §4.3, UI-ТЗ §3) — a thin wrapper around the shared
 * PointScene: real projection coordinates from the backend cache, the same
 * selection state as every other view (TZ §4.4).
 *
 * Interactions (no explicit mode buttons — by user feedback): orbit with
 * LMB-drag, hold Shift to draw a selection marquee (Ctrl adds the area to
 * the selection), click selects a point (Ctrl toggles), Esc clears.
 *
 * Stage-4 overlays: the ORIGINAL-space slice (dim/hide out-of-layer points —
 * the slice itself is a selection in the D-dimensional space, the scene only
 * DISPLAYS it through this projection), cluster coloring (explicit run) and
 * structural relation lines of the active fragment (type filters + limit —
 * never an unreadable hairball, TZ §7.2).
 */

export function Scene3D() {
  const cloud = useSpaceStore((s) => s.cloud3d);
  const loading = useSpaceStore((s) => s.loading3d);
  const error = useSpaceStore((s) => s.error);
  const sliceOverlay = useSpaceStore((s) => s.sliceOverlay);
  const sliceDisplay = useSpaceStore((s) => s.sliceDisplay);
  const colorBy = useSpaceStore((s) => s.colorBy);
  const clusterLabels = useSpaceStore((s) => s.clusterLabels);
  const clusterCaption = useSpaceStore((s) => s.clusterCaption);
  const setColorBy = useSpaceStore((s) => s.setColorBy);
  const relationLinesOn = useSpaceStore((s) => s.relationLines);
  const setRelationLines = useSpaceStore((s) => s.setRelationLines);

  const activeFragmentId = useProjectStore((s) => s.activeFragmentId);
  const fragmentRelations = useAnalysisStore((s) => s.fragmentRelations);
  const fragmentRelationsFor = useAnalysisStore((s) => s.fragmentRelationsFor);
  const loadFragmentRelations = useAnalysisStore((s) => s.loadFragmentRelations);

  const [kindFilter, setKindFilter] = useState<Record<string, boolean>>({});

  /* Relation lines follow the active fragment (shared cache with the
     RELATIONS tab of the left panel). */
  useEffect(() => {
    if (relationLinesOn && activeFragmentId && fragmentRelationsFor !== activeFragmentId) {
      void loadFragmentRelations(activeFragmentId);
    }
  }, [relationLinesOn, activeFragmentId, fragmentRelationsFor, loadFragmentRelations]);

  /* Slice masks over THIS cloud (only when the projection's embedding run
     matches the slice's run — membership of other vectors is undefined). */
  const fragmentIds = useMemo(
    () => (cloud ? cloud.metas.map((m) => m.fragmentId) : []),
    [cloud],
  );
  const sliceMasks = useMemo(() => {
    if (!cloud || !sliceOverlay) return null;
    return sliceMasksForCloud(
      fragmentIds,
      sliceOverlay,
      cloud.projection.embedding_run_id,
      sliceDisplay,
    );
  }, [cloud, sliceOverlay, sliceDisplay, fragmentIds]);

  const colorOf = useMemo<PointColorOf | undefined>(
    () => (colorBy === "cluster" && clusterLabels ? makeClusterColorOf(clusterLabels) : undefined),
    [colorBy, clusterLabels],
  );

  /* Relation line buffers: active fragment → related fragments present in
     this cloud; file-level endpoints and off-cloud targets are counted and
     reported honestly, never drawn as guesses. */
  const linesData = useMemo(() => {
    if (!relationLinesOn || !cloud || !activeFragmentId) return null;
    if (!fragmentRelations || fragmentRelationsFor !== activeFragmentId) return null;
    const anchor = cloud.indexById.get(activeFragmentId);
    if (anchor === undefined) return null;
    const positions: number[] = [];
    const colors: number[] = [];
    const kindCounts = new Map<string, number>();
    let drawn = 0;
    let capped = 0;
    let fileLevel = 0;
    let offCloud = 0;
    for (const rel of fragmentRelations.items) {
      const fromSource = rel.source.fragment_id === activeFragmentId;
      const fromTarget = rel.target.fragment_id === activeFragmentId;
      if (!fromSource && !fromTarget) continue;
      const other = fromSource ? rel.target : rel.source;
      if (other.fragment_id === null) {
        fileLevel += 1;
        continue;
      }
      // kinds are counted BEFORE the filter: an unchecked type must keep its
      // checkbox so it can be turned back on
      kindCounts.set(rel.kind, (kindCounts.get(rel.kind) ?? 0) + 1);
      if (kindFilter[rel.kind] === false) continue;
      const oi = cloud.indexById.get(other.fragment_id);
      if (oi === undefined) {
        offCloud += 1;
        continue;
      }
      if (drawn >= RELATION_LINE_LIMIT) {
        capped += 1;
        continue;
      }
      drawn += 1;
      positions.push(
        cloud.display[anchor * 3],
        cloud.display[anchor * 3 + 1],
        cloud.display[anchor * 3 + 2],
        cloud.display[oi * 3],
        cloud.display[oi * 3 + 1],
        cloud.display[oi * 3 + 2],
      );
      const [r, g, b] = hexToRgb(relationColor(rel.kind));
      colors.push(r, g, b, r, g, b);
    }
    return {
      buffers:
        positions.length > 0
          ? { positions: new Float32Array(positions), colors: new Float32Array(colors) }
          : null,
      kindCounts,
      drawn,
      capped,
      fileLevel,
      offCloud,
    };
  }, [
    relationLinesOn,
    cloud,
    activeFragmentId,
    fragmentRelations,
    fragmentRelationsFor,
    kindFilter,
  ]);

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
          3D-пространство пусто. Постройте проекцию на панели ниже (метод, seed,
          «Построить проекцию»); координаты будут получены из сохранённых
          эмбеддингов. Если векторов ещё нет — сначала рассчитайте их в разделе
          EXPERIMENTS.
        </div>
      </div>
    );
  }

  const projection = cloud.projection;
  const sliceActive = sliceMasks !== null;

  return (
    <PointScene
      cloud={cloud}
      hoverKind="3d"
      ariaLabel="3D embedding-пространство (проекция)"
      mask={sliceMasks?.mask ?? null}
      dimMask={sliceMasks?.dimMask ?? null}
      colorOf={colorOf}
      lines={linesData?.buffers ?? null}
      className={sliceActive || linesData ? "point-scene--with-footer" : undefined}
      badge={
        <span title={`Запуск ${projection.id}`}>
          {projection.method_display_name} · 3D · {cloud.points.count} точек
          {projection.stale && <span className="badge badge--warn"> устарела</span>}
          {!projection.stale && <span className="badge"> свежая</span>}
          {sliceActive && sliceMasks && (
            <span
              className="badge"
              title="Слой выбран в ИСХОДНОМ пространстве; сцена показывает его через эту проекцию"
            >
              {" "}
              слой: {sliceMasks.inLayer} из {sliceMasks.total}
            </span>
          )}
          {colorBy === "cluster" && clusterCaption && (
            <span className="badge" title="Раскраска по кластерам выбранного запуска">
              {" "}
              {clusterCaption}
            </span>
          )}
        </span>
      }
      toolbarExtras={
        <>
          <button
            type="button"
            className={`btn btn--small${relationLinesOn ? " btn--primary" : ""}`}
            onClick={() => setRelationLines(!relationLinesOn)}
            aria-pressed={relationLinesOn}
            title="Линии структурных связей активной точки (только фрагменты этого облака; типы фильтруются внизу)"
          >
            ⇄ Связи
          </button>
          <button
            type="button"
            className={`btn btn--small${colorBy === "cluster" ? " btn--primary" : ""}`}
            onClick={() => setColorBy(colorBy === "kind" ? "cluster" : "kind")}
            disabled={colorBy === "kind" && !clusterLabels}
            aria-pressed={colorBy === "cluster"}
            title={
              clusterLabels
                ? "Раскраска точек: по типу фрагмента / по кластеру (запуск выбран во вкладке CLUSTERS)"
                : "Сначала запустите кластеризацию и нажмите «На сцену» во вкладке CLUSTERS"
            }
          >
            цвет: {colorBy === "kind" ? "тип" : "кластер"}
          </button>
        </>
      }
      footer={
        linesData ? (
          <div className="scene3d__relpanel" role="group" aria-label="Фильтры линий связей">
            <span className="scene3d__relpanel-title mono">
              связи: {linesData.drawn}
              {linesData.capped > 0 && ` (ещё ${linesData.capped} за лимитом ${RELATION_LINE_LIMIT})`}
            </span>
            {[...linesData.kindCounts.entries()].map(([kind, count]) => (
              <label key={kind} className="scene3d__relfilter">
                <input
                  type="checkbox"
                  checked={kindFilter[kind] !== false}
                  onChange={(e) => setKindFilter({ ...kindFilter, [kind]: e.target.checked })}
                />
                <span
                  className="legend-item__dot"
                  style={{ background: relationColor(kind) }}
                  aria-hidden="true"
                />
                <span className="mono">{kind}</span>
                <span className="mono scene3d__relfilter-count">{count}</span>
              </label>
            ))}
            {(linesData.fileLevel > 0 || linesData.offCloud > 0) && (
              <span className="scene3d__relnote">
                не нарисовано: {linesData.fileLevel > 0 && `${linesData.fileLevel} файловых`}
                {linesData.fileLevel > 0 && linesData.offCloud > 0 && ", "}
                {linesData.offCloud > 0 && `${linesData.offCloud} вне этого облака`}
              </span>
            )}
            {linesData.drawn === 0 && (
              <span className="scene3d__relnote">
                у активной точки нет связей с концами-фрагментами в этом облаке
              </span>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
