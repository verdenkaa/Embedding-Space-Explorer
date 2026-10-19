import { useState } from "react";

import type { WorkspaceEntryKind } from "../../api/types";
import { CREATE_FOLDERS, KIND_DEFAULTS, emptyNotebookJson } from "./researchFiles";
import type { CreateKind } from "./researchFiles";

interface CreateDialogProps {
  kind: CreateKind;
  projectId: string;
  onCreate: (path: string, entryKind: WorkspaceEntryKind, content: string) => Promise<boolean>;
  onClose: () => void;
}

export function CreateDialog({ kind, projectId, onCreate, onClose }: CreateDialogProps) {
  const defaults = KIND_DEFAULTS[kind];
  const [name, setName] = useState("");
  const [folder, setFolder] = useState(defaults.folder);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    let fileName = name.trim();
    if (!fileName) {
      setError("Введите имя.");
      return;
    }
    if (fileName.includes("/") || fileName.includes("\\")) {
      setError("Имя не должно содержать разделители пути — папка выбирается отдельно.");
      return;
    }
    if (defaults.ext && !fileName.toLowerCase().endsWith(defaults.ext)) {
      fileName += defaults.ext;
    }
    const path = `${folder}/${fileName}`;
    const entryKind: WorkspaceEntryKind = kind === "dir" ? "dir" : "file";
    let content = "";
    if (kind === "notebook") content = emptyNotebookJson(projectId);
    if (kind === "note") content = `# ${fileName.replace(/\.md$/i, "")}\n\n`;
    setPending(true);
    setError(null);
    const ok = await onCreate(path, entryKind, content);
    setPending(false);
    if (ok) onClose();
    else setError("Не удалось создать — см. сообщение об ошибке выше.");
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal research-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-create-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="research-create-title" className="modal__title">
          {defaults.title}
        </h3>
        <label className="research-dialog__label" htmlFor="research-create-folder">
          Папка в рабочем пространстве
        </label>
        <select
          id="research-create-folder"
          className="create-form__input research-dialog__select"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        >
          {CREATE_FOLDERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="research-dialog__label" htmlFor="research-create-name">
          Имя{defaults.ext ? ` (расширение ${defaults.ext} добавится автоматически)` : ""}
        </label>
        <input
          id="research-create-name"
          className="create-form__input mono"
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <p className="research-dialog__error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="btn btn--small" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn--small btn--primary"
            disabled={pending}
            onClick={() => void submit()}
          >
            {pending ? "Создание…" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RenameDialogProps {
  path: string;
  onRename: (fromPath: string, toPath: string) => Promise<boolean>;
  onClose: () => void;
}

export function RenameDialog({ path, onRename, onClose }: RenameDialogProps) {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const [name, setName] = useState(slash >= 0 ? path.slice(slash + 1) : path);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
      setError("Введите корректное имя файла (без разделителей пути).");
      return;
    }
    setPending(true);
    setError(null);
    const ok = await onRename(path, `${dir}${trimmed}`);
    setPending(false);
    if (ok) onClose();
    else setError("Не удалось переименовать — см. сообщение об ошибке выше.");
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal research-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-rename-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="research-rename-title" className="modal__title">
          Переименовать
        </h3>
        <p className="modal__subtitle mono">{dir || "/"}</p>
        <input
          className="create-form__input mono"
          value={name}
          autoFocus
          spellCheck={false}
          aria-label="Новое имя"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") onClose();
          }}
        />
        {error && <p className="research-dialog__error">{error}</p>}
        <div className="modal__actions">
          <button type="button" className="btn btn--small" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn--small btn--primary"
            disabled={pending}
            onClick={() => void submit()}
          >
            {pending ? "Переименование…" : "Переименовать"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DeleteDialogProps {
  path: string;
  isDir: boolean;
  onDelete: (path: string, confirm: boolean) => Promise<boolean>;
  onClose: () => void;
}

export function DeleteDialog({ path, isDir, onDelete, onClose }: DeleteDialogProps) {
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    const ok = await onDelete(path, isDir);
    setPending(false);
    if (ok) onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal research-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="research-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="research-delete-title" className="modal__title">
          Удалить {isDir ? "папку" : "файл"}?
        </h3>
        <p className="modal__subtitle mono">{path}</p>
        {isDir && (
          <p className="research-dialog__warning">
            Папка будет удалена вместе со всем содержимым. Действие необратимо.
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="btn btn--small" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn--small btn--danger"
            disabled={pending}
            onClick={() => void submit()}
          >
            {pending ? "Удаление…" : "Удалить"}
          </button>
        </div>
      </div>
    </div>
  );
}
