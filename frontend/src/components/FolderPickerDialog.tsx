import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { FsListResponse } from "../api/types";

interface FolderPickerDialogProps {
  onPick: (path: string) => void;
  onCancel: () => void;
}

/**
 * Server-side directory browser (the browser itself cannot reveal local
 * paths). Lists directory NAMES only — never files.
 */
export function FolderPickerDialog({ onPick, onCancel }: FolderPickerDialogProps) {
  const [listing, setListing] = useState<FsListResponse | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listDirs(path);
      setListing(data);
      setPathInput(data.path ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const current = listing?.path ?? null;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal folder-picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <h3 id="picker-title" className="modal__title">
          Выбор папки
        </h3>

        <div className="folder-picker__nav">
          <button
            type="button"
            className="btn btn--small"
            disabled={!listing?.parent}
            onClick={() => void load(listing?.parent ?? undefined)}
            title="Вверх"
          >
            ↑
          </button>
          <input
            className="folder-picker__path mono"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(pathInput);
            }}
            aria-label="Путь к каталогу"
            spellCheck={false}
          />
          <button type="button" className="btn btn--small" onClick={() => void load(pathInput)}>
            Перейти
          </button>
        </div>

        {error && <p className="folder-picker__error">{error}</p>}

        <ul className="folder-picker__list" aria-label="Каталоги">
          {loading && <li className="empty-hint">Загрузка…</li>}
          {!loading &&
            (listing?.entries ?? []).map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="folder-picker__entry"
                  onDoubleClick={() => void load(entry.path)}
                  onClick={() => setPathInput(entry.path)}
                  title="Двойной клик — войти; одинарный — сделать текущей"
                >
                  <span aria-hidden="true">🗀</span> {entry.name}
                </button>
              </li>
            ))}
          {!loading && (listing?.entries.length ?? 0) === 0 && (
            <li className="empty-hint">Каталогов нет (или нет доступа).</li>
          )}
        </ul>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!current}
            onClick={() => current && onPick(current)}
          >
            Выбрать {current ? `«${current}»` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
