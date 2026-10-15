import type { FragmentMeta } from "../../api/types";
import { kindBadge, kindColorClass } from "../../monaco/helpers";

interface FragmentListProps {
  fragments: FragmentMeta[];
  activeFragmentId: string | null;
  showPath?: boolean;
  /** Search-result mode entries carry rel_path. */
  paths?: Record<string, string>;
  onSelect: (fragment: FragmentMeta) => void;
  emptyHint: string;
}

export function FragmentList({
  fragments,
  activeFragmentId,
  showPath,
  paths,
  onSelect,
  emptyHint,
}: FragmentListProps) {
  if (fragments.length === 0) {
    return <div className="empty-hint">{emptyHint}</div>;
  }
  return (
    <ul className="fragment-list" aria-label="Фрагменты">
      {fragments.map((fragment) => {
        const active = fragment.id === activeFragmentId;
        const path = paths?.[fragment.id];
        return (
          <li key={fragment.id}>
            <button
              type="button"
              className={`fragment-row${active ? " fragment-row--active" : ""}`}
              onClick={() => onSelect(fragment)}
              title={`${fragment.symbol_path}\nстроки ${fragment.start_line}-${fragment.end_line}\nметод: ${fragment.method}`}
            >
              <span className={`fragment-row__kind ${kindColorClass(fragment.kind)}`}>
                {kindBadge(fragment.kind)}
              </span>
              <span className="fragment-row__body">
                <span className="fragment-row__name">{fragment.name ?? fragment.symbol_path}</span>
                {showPath && path && <span className="fragment-row__path">{path}</span>}
              </span>
              <span className="fragment-row__lines mono">
                {fragment.start_line}–{fragment.end_line}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
