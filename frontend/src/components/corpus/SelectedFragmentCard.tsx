import type { FragmentMeta } from "../../api/types";
import { kindBadge, kindColorClass } from "../../monaco/helpers";

/** Compact card with the active fragment's traceability data (UI-ТЗ §5). */
export function SelectedFragmentCard({ fragment }: { fragment: FragmentMeta | null }) {
  if (!fragment) return null;
  return (
    <div className="fragment-card" aria-label="Выбранный фрагмент">
      <div className="fragment-card__head">
        <span className={`fragment-row__kind ${kindColorClass(fragment.kind)}`}>
          {kindBadge(fragment.kind)}
        </span>
        <span className="fragment-card__name mono" title={fragment.symbol_path}>
          {fragment.name ?? fragment.symbol_path}
        </span>
      </div>
      <dl className="fragment-card__grid">
        <dt>symbol_path</dt>
        <dd className="mono">{fragment.symbol_path}</dd>
        {fragment.parent_symbol_path && (
          <>
            <dt>родитель</dt>
            <dd className="mono">{fragment.parent_symbol_path}</dd>
          </>
        )}
        <dt>строки</dt>
        <dd className="mono">
          {fragment.start_line}–{fragment.end_line}
        </dd>
        <dt>метод</dt>
        <dd className="mono">{fragment.method}</dd>
        <dt>id</dt>
        <dd className="mono" title="Стабильный ID: не меняется при неизменном содержимом">
          {fragment.id}
        </dd>
      </dl>
    </div>
  );
}
