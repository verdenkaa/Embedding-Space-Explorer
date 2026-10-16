import { useEffect } from "react";

import type { RelationDTO, RelationEndpointDTO } from "../../api/types";
import { endpointToRef } from "../../space/fragmentRef";
import { ORIGIN_LABELS, relationBadge, relationGlyph } from "../../space/relationLabels";
import { useAnalysisStore } from "../../state/analysisStore";
import { useProjectStore } from "../../state/projectStore";
import { AnalysisJobProgress } from "./NeighborsTab";

/**
 * RELATIONS tab (TZ §7.2): STRUCTURAL relations of the active fragment —
 * visually and semantically separate from semantic neighbors: every kind has
 * a text badge + glyph, every row shows its provenance (extracted /
 * imported / manual). File-level endpoints are shown as files (honest —
 * a top-level import belongs to no fragment).
 */

function endpointLabel(ep: RelationEndpointDTO): string {
  if (ep.fragment_id !== null) {
    const name = ep.name ?? ep.symbol_path ?? "фрагмент";
    return ep.start_line !== null ? `${name} · :${ep.start_line}–${ep.end_line}` : name;
  }
  return ep.rel_path ?? "файл";
}

function RelationRow({ rel, outgoing }: { rel: RelationDTO; outgoing: boolean }) {
  const selectFragment = useProjectStore((s) => s.selectFragment);
  const selectFile = useProjectStore((s) => s.selectFile);
  const deleteRelation = useAnalysisStore((s) => s.deleteRelation);

  const other = outgoing ? rel.target : rel.source;
  const ref = endpointToRef(other);

  const onClick = () => {
    if (ref) {
      void selectFragment(ref);
    } else if (other.file_id) {
      void selectFile(other.file_id);
    }
  };

  return (
    <li className="relation-row">
      <button
        type="button"
        className="relation-row__main"
        onClick={onClick}
        disabled={!ref && !other.file_id}
        title={
          other.rel_path
            ? `${other.rel_path}${other.start_line ? `:${other.start_line}–${other.end_line}` : ""}`
            : undefined
        }
      >
        <span className="relation-row__glyph mono" aria-hidden="true">
          {relationGlyph(rel.kind)}
        </span>
        <span className="legend-item__badge mono">{relationBadge(rel.kind)}</span>
        <span className="relation-row__dir mono" aria-hidden="true">
          {outgoing ? "→" : "←"}
        </span>
        <span className="relation-row__label">{endpointLabel(other)}</span>
        {rel.confidence !== null && (
          <span className="relation-row__conf mono" title="Уверенность источника">
            {Math.round(rel.confidence * 100)}%
          </span>
        )}
      </button>
      <span
        className="relation-row__origin mono"
        title="Происхождение связи (никогда не смешивается)"
      >
        {ORIGIN_LABELS[rel.origin] ?? rel.origin}
      </span>
      <button
        type="button"
        className="relation-row__delete btn btn--small"
        onClick={() => void deleteRelation(rel.id)}
        aria-label={`Удалить связь ${rel.kind}`}
        title="Удалить связь (извлечённые вернутся при повторном извлечении)"
      >
        ✕
      </button>
    </li>
  );
}

export function RelationsTab() {
  const activeFragmentId = useProjectStore((s) => s.activeFragmentId);
  const fragmentRelations = useAnalysisStore((s) => s.fragmentRelations);
  const fragmentRelationsFor = useAnalysisStore((s) => s.fragmentRelationsFor);
  const loading = useAnalysisStore((s) => s.relationsLoading);
  const loadFragmentRelations = useAnalysisStore((s) => s.loadFragmentRelations);
  const extractRelations = useAnalysisStore((s) => s.extractRelations);
  const activeJob = useAnalysisStore((s) => s.activeJob);

  useEffect(() => {
    if (!activeFragmentId) return;
    void loadFragmentRelations(activeFragmentId);
  }, [activeFragmentId, loadFragmentRelations]);

  const current =
    fragmentRelations && fragmentRelationsFor === activeFragmentId ? fragmentRelations : null;
  const items = current?.items ?? [];
  const outgoing = items.filter((r) => r.source.fragment_id === activeFragmentId);
  const incoming = items.filter((r) => r.target.fragment_id === activeFragmentId);
  const jobRunning = activeJob?.state === "queued" || activeJob?.state === "running";

  return (
    <div className="analysis-pane" aria-label="Структурные связи">
      <div className="analysis-pane__controls">
        <button
          type="button"
          className="btn btn--small"
          onClick={() => void extractRelations()}
          disabled={jobRunning}
          title="Пересчитать поверхностные связи корпуса: imports (tree-sitter) и belongs_to"
        >
          Извлечь связи
        </button>
        {activeFragmentId && (
          <button
            type="button"
            className="btn btn--small"
            onClick={() => void loadFragmentRelations(activeFragmentId)}
            disabled={loading}
          >
            Обновить
          </button>
        )}
      </div>
      <AnalysisJobProgress />

      {!activeFragmentId && (
        <div className="empty-hint">
          Выберите точку или фрагмент — здесь появятся его структурные связи
          (импорты, принадлежность, импортированные и ручные отношения).
        </div>
      )}
      {activeFragmentId && current && items.length === 0 && (
        <div className="empty-hint empty-hint--accent">
          У этого фрагмента пока нет связей. Нажмите «Извлечь связи»
          (imports/belongs_to из исходников) или импортируйте корпус связей в
          разделе RELATIONS.
        </div>
      )}

      {current && items.length > 0 && (
        <>
          <p className="analysis-pane__note">
            Структурные связи — НЕ семантическая близость: источник каждой
            подписан (извлечено / импорт / вручную).
          </p>
          {outgoing.length > 0 && (
            <>
              <h4 className="analysis-pane__subtitle">Исходящие · {outgoing.length}</h4>
              <ul className="relations-list">
                {outgoing.map((rel) => (
                  <RelationRow key={rel.id} rel={rel} outgoing />
                ))}
              </ul>
            </>
          )}
          {incoming.length > 0 && (
            <>
              <h4 className="analysis-pane__subtitle">Входящие · {incoming.length}</h4>
              <ul className="relations-list">
                {incoming.map((rel) => (
                  <RelationRow key={rel.id} rel={rel} outgoing={false} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
