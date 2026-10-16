import { useSpaceStore } from "../../state/spaceStore";
import { PointScene } from "./PointScene";

/**
 * 3D embedding space (TZ §4.3, UI-ТЗ §3) — a thin wrapper around the shared
 * PointScene: real projection coordinates from the backend cache, the same
 * selection state as every other view (TZ §4.4).
 *
 * Interactions (no explicit mode buttons — by user feedback): orbit with
 * LMB-drag, hold Shift to draw a selection marquee (Ctrl adds the area to
 * the selection), click selects a point (Ctrl toggles), Esc clears.
 */

export function Scene3D() {
  const cloud = useSpaceStore((s) => s.cloud3d);
  const loading = useSpaceStore((s) => s.loading3d);
  const error = useSpaceStore((s) => s.error);

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

  return (
    <PointScene
      cloud={cloud}
      hoverKind="3d"
      ariaLabel="3D embedding-пространство (проекция)"
      badge={
        <span title={`Запуск ${projection.id}`}>
          {projection.method_display_name} · 3D · {cloud.points.count} точек
          {projection.stale && <span className="badge badge--warn"> устарела</span>}
          {!projection.stale && <span className="badge"> свежая</span>}
        </span>
      }
    />
  );
}
