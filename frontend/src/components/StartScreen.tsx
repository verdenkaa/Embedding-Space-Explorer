import { useEffect, useState } from "react";

import type { CreateProjectRequest, SplitOptions } from "../api/types";
import { useProjectStore } from "../state/projectStore";
import { FolderPickerDialog } from "./FolderPickerDialog";

/**
 * Start screen: the short path — open/create a project, then index.
 * Shown when no project is open.
 */
export function StartScreen() {
  const projects = useProjectStore((s) => s.projects);
  const error = useProjectStore((s) => s.error);
  const loading = useProjectStore((s) => s.loading);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const openProject = useProjectStore((s) => s.openProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const createProject = useProjectStore((s) => s.createProject);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [options, setOptions] = useState<Partial<SplitOptions>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const submit = async () => {
    if (!name.trim() || roots.length === 0) return;
    const payload: CreateProjectRequest = {
      name: name.trim(),
      roots,
      split_options: Object.keys(options).length > 0 ? options : null,
    };
    const created = await createProject(payload);
    if (created) {
      setCreating(false);
      setName("");
      setRoots([]);
      setOptions({});
    }
  };

  return (
    <div className="start-screen">
      <div className="start-screen__header">
        <h1 className="start-screen__title">Начало работы</h1>
        <p className="start-screen__subtitle">
          Короткий путь: <b>1.</b> открыть или создать проект → <b>2.</b> индексировать корпус →{" "}
          <b>3.</b> посчитать эмбеддинги (EXPERIMENTS) → <b>4.</b> построить проекции и
          исследовать пространство (SPACE).
        </p>
        {error && (
          <p className="start-screen__error" role="alert">
            {error.message} {error.hint ?? ""}
          </p>
        )}
      </div>

      <div className="start-screen__columns">
        <section className="panel-card start-card" aria-labelledby="open-title">
          <h2 className="panel-card__title" id="open-title">
            Открыть проект
          </h2>
          {projects === null && <p className="empty-hint">Загрузка списка…</p>}
          {projects !== null && projects.length === 0 && (
            <p className="empty-hint">Сохранённых проектов нет — создайте новый справа.</p>
          )}
          <ul className="project-list">
            {(projects ?? []).map((p) => (
              <li key={p.id} className="project-list__item">
                <button
                  type="button"
                  className="project-list__open"
                  disabled={p.error !== null || loading}
                  onClick={() => void openProject(p.id)}
                  title={p.error ?? p.roots.join("\n")}
                >
                  <span className="project-list__name">{p.name}</span>
                  <span className="project-list__meta mono">
                    {p.error ? p.error : `изменён ${p.updated_at}`}
                  </span>
                </button>
                {confirmDeleteId === p.id ? (
                  <span className="project-list__confirm">
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      onClick={() => {
                        void deleteProject(p.id);
                        setConfirmDeleteId(null);
                      }}
                    >
                      Удалить?
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Нет
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn--small btn--icon"
                    title="Удалить проект (с запросом подтверждения)"
                    onClick={() => setConfirmDeleteId(p.id)}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="panel-card start-card" aria-labelledby="create-title">
          <h2 className="panel-card__title" id="create-title">
            Создать проект
          </h2>
          {!creating ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setCreating(true)}
              disabled={loading}
            >
              Новый проект…
            </button>
          ) : (
            <div className="create-form">
              <label className="create-form__label" htmlFor="project-name">
                Название
              </label>
              <input
                id="project-name"
                className="create-form__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="например: my-research"
                maxLength={200}
              />

              <span className="create-form__label">Корни исходников</span>
              <ul className="create-form__roots">
                {roots.map((root) => (
                  <li key={root} className="mono">
                    <span className="create-form__root-path" title={root}>
                      {root}
                    </span>
                    <button
                      type="button"
                      className="btn btn--small btn--icon"
                      onClick={() => setRoots((prev) => prev.filter((r) => r !== root))}
                      title="Убрать корень"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn--small" onClick={() => setPicking(true)}>
                + Добавить папку…
              </button>

              <button
                type="button"
                className="create-form__advanced-toggle"
                onClick={() => setAdvanced((v) => !v)}
                aria-expanded={advanced}
              >
                {advanced ? "▾" : "▸"} Параметры сегментации
              </button>
              {advanced && (
                <div className="create-form__advanced">
                  <NumberField
                    label="Макс. размер файла, байт"
                    value={options.max_file_size_bytes ?? 1_000_000}
                    onChange={(v) => setOptions((o) => ({ ...o, max_file_size_bytes: v }))}
                  />
                  <NumberField
                    label="Макс. строк во фрагменте"
                    value={options.max_fragment_lines ?? 200}
                    onChange={(v) => setOptions((o) => ({ ...o, max_fragment_lines: v }))}
                  />
                  <NumberField
                    label="Строк в fallback-чанке"
                    value={options.fallback_chunk_lines ?? 80}
                    onChange={(v) => setOptions((o) => ({ ...o, fallback_chunk_lines: v }))}
                  />
                  <NumberField
                    label="Перекрытие чанков, строк"
                    value={options.fallback_overlap_lines ?? 10}
                    onChange={(v) => setOptions((o) => ({ ...o, fallback_overlap_lines: v }))}
                  />
                  <PatternField
                    label="Исключить (glob-паттерны через запятую)"
                    value={(options.extra_exclude_patterns ?? []).join(", ")}
                    onChange={(list) => setOptions((o) => ({ ...o, extra_exclude_patterns: list }))}
                  />
                  <PatternField
                    label="Включать только (glob, пусто = все)"
                    value={(options.extra_include_patterns ?? []).join(", ")}
                    onChange={(list) => setOptions((o) => ({ ...o, extra_include_patterns: list }))}
                  />
                  <label className="create-form__checkbox">
                    <input
                      type="checkbox"
                      checked={options.include_hidden ?? false}
                      onChange={(e) =>
                        setOptions((o) => ({ ...o, include_hidden: e.target.checked }))
                      }
                    />
                    Индексировать скрытые файлы и папки
                  </label>
                </div>
              )}

              <div className="modal__actions">
                <button type="button" className="btn" onClick={() => setCreating(false)}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!name.trim() || roots.length === 0 || loading}
                  onClick={() => void submit()}
                  title={
                    !name.trim()
                      ? "Введите название"
                      : roots.length === 0
                        ? "Добавьте хотя бы одну папку"
                        : "Создать проект"
                  }
                >
                  Создать
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      {picking && (
        <FolderPickerDialog
          onPick={(path) => {
            setRoots((prev) => (prev.includes(path) ? prev : [...prev, path]));
            setPicking(false);
          }}
          onCancel={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="create-form__field">
      <span>{label}</span>
      <input
        type="number"
        className="create-form__input create-form__input--num mono"
        value={value}
        min={1}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(parsed) && parsed >= 0) onChange(parsed);
        }}
      />
    </label>
  );
}

function PatternField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (list: string[]) => void;
}) {
  return (
    <label className="create-form__field">
      <span>{label}</span>
      <input
        className="create-form__input mono"
        value={value}
        placeholder="*.min.js, generated/*"
        onChange={(e) =>
          onChange(
            e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }
      />
    </label>
  );
}
