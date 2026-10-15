import { useProjectStore } from "../state/projectStore";

const MAX_LISTED = 100;

function ChangeList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="changes-group">
      <h4 className="changes-group__title">
        {title} <span className="mono">{items.length}</span>
      </h4>
      <ul className="changes-group__list">
        {items.slice(0, MAX_LISTED).map((item) => (
          <li key={item} className="mono">
            {item}
          </li>
        ))}
        {items.length > MAX_LISTED && <li>…и ещё {items.length - MAX_LISTED}</li>}
      </ul>
    </div>
  );
}

/**
 * Confirmation dialog for scenario D: shows new/modified/deleted files from a
 * live scan BEFORE anything is recomputed. Nothing is applied until the user
 * confirms (TZ §6.1, §9.3).
 */
export function ChangesDialog() {
  const changes = useProjectStore((s) => s.changes);
  const closeChanges = useProjectStore((s) => s.closeChanges);
  const startIndex = useProjectStore((s) => s.startIndex);

  if (!changes) return null;

  const totalChanges = changes.new.length + changes.modified.length + changes.deleted.length;
  const skippedByReason = changes.skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal changes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changes-title"
      >
        <h3 id="changes-title" className="modal__title">
          Изменения корпуса
        </h3>

        <p className="modal__subtitle">
          Без подтверждения ничего не пересчитывается. Неизменившихся файлов:{" "}
          <span className="mono">{changes.unchanged_count}</span>.
        </p>

        {changes.root_errors.length > 0 && (
          <div className="changes-errors">
            {changes.root_errors.map((err) => (
              <p key={err} className="changes-errors__item">
                {err}
              </p>
            ))}
          </div>
        )}
        {changes.warnings.length > 0 && (
          <div className="changes-warnings">
            {changes.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        )}

        <div className="changes-body">
          <ChangeList title="Новые" items={changes.new.map((c) => c.rel_path)} />
          <ChangeList
            title="Изменённые"
            items={changes.modified.map((c) => `${c.rel_path} (${c.reason})`)}
          />
          <ChangeList title="Удалённые" items={changes.deleted} />
          {totalChanges === 0 && (
            <p className="empty-hint">Изменений нет — индекс актуален.</p>
          )}

          {changes.skipped.length > 0 && (
            <details className="changes-skipped">
              <summary>
                Пропущено файлов: <span className="mono">{changes.skipped.length}</span>{" "}
                (по причинам)
              </summary>
              <ul className="changes-skipped__reasons">
                {Object.entries(skippedByReason).map(([reason, count]) => (
                  <li key={reason} className="mono">
                    {reason}: {count}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={closeChanges}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={totalChanges === 0}
            onClick={() => void startIndex()}
            title="Пересчитать только затронутые файлы; неизменившиеся останутся в кэше"
          >
            Применить и переиндексировать
          </button>
        </div>
      </div>
    </div>
  );
}
