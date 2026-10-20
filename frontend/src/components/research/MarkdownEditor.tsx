import { Editor } from "@monaco-editor/react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { useEffect, useMemo } from "react";

import { renderMarkdown } from "../../markdown/renderMarkdown";
import { rewriteHtmlImages } from "../../markdown/workspaceImages";
import { ESE_THEME } from "../../monaco/helpers";
import type { NoteMode } from "../../state/markdownStore";
import { useMarkdownStore } from "../../state/markdownStore";
import { CrepeHost } from "./CrepeHost";

const MODES: { id: NoteMode; label: string; title: string }[] = [
  {
    id: "wysiwyg",
    label: "Текст",
    title: "WYSIWYG (Milkdown Crepe): форматирование и формулы LaTeX по месту",
  },
  { id: "source", label: "Исходник", title: "Исходная Markdown-разметка (Monaco) — без преобразований" },
  { id: "preview", label: "Просмотр", title: "Отрендеренный документ (KaTeX) — так же рендерится экспорт" },
  { id: "split", label: "Сплит", title: "Исходник и предпросмотр рядом" },
];

const SOURCE_OPTIONS = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  lineHeight: 20,
  wordWrap: "on" as const,
  wrappingStrategy: "advanced" as const,
  automaticLayout: true,
  padding: { top: 8, bottom: 8 },
  renderLineHighlight: "none" as const,
  overviewRulerLanes: 0,
  lineDecorationsWidth: 4,
  folding: false,
  glyphMargin: false,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
};

/**
 * Markdown note editor (TZ §6): Milkdown Crepe WYSIWYG with KaTeX plus
 * source (Monaco) / preview / split modes over the SAME markdown source.
 * The document lives in markdownStore (server-backed .md on disk — never
 * localStorage); the original markup is the single source of truth: preview
 * and WYSIWYG are only renderings of it.
 */
export function MarkdownEditor({ projectId, path }: { projectId: string; path: string }) {
  const doc = useMarkdownStore((s) => s.doc);
  const dirty = useMarkdownStore((s) => s.dirty);
  const saving = useMarkdownStore((s) => s.saving);
  const loading = useMarkdownStore((s) => s.loading);
  const conflict = useMarkdownStore((s) => s.conflict);
  const reloadToken = useMarkdownStore((s) => s.reloadToken);
  const error = useMarkdownStore((s) => s.error);
  const notice = useMarkdownStore((s) => s.notice);
  const mode = useMarkdownStore((s) => s.mode);
  const open = useMarkdownStore((s) => s.open);
  const reload = useMarkdownStore((s) => s.reload);
  const save = useMarkdownStore((s) => s.save);
  const setContent = useMarkdownStore((s) => s.setContent);
  const setMode = useMarkdownStore((s) => s.setMode);
  const dismissNotice = useMarkdownStore((s) => s.dismissNotice);
  const clearError = useMarkdownStore((s) => s.clearError);

  /* (Re)load the document whenever a different note/project is opened. */
  useEffect(() => {
    void open(projectId, path);
  }, [projectId, path, open]);

  /* Warn before closing the browser tab with unsaved changes (TZ §6.5). */
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  /* Ctrl+S saves (capture phase so Monaco/Crepe do not swallow it). */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void useMarkdownStore.getState().save();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  /* External changes (notebook kernel writes into notes/ are expected):
     re-check the file on window focus. */
  useEffect(() => {
    const onFocus = () => {
      void useMarkdownStore.getState().recheckExternal();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  /* Notices are transient (same behaviour as the research tree notices). */
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 4000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  const previewHtml = useMemo(
    () => (doc ? rewriteHtmlImages(renderMarkdown(doc.content), projectId, doc.path) : ""),
    [doc, projectId],
  );

  if (loading && !doc) {
    return (
      <div className="note-editor">
        <div className="empty-hint empty-hint--center">Загрузка заметки…</div>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="note-editor">
        <div className="empty-hint empty-hint--center">
          {error ? error.message : "Заметка не открыта."}
        </div>
      </div>
    );
  }

  const sourcePane = (
    <div className="note-editor__source" data-testid="note-source">
      <Editor
        height="100%"
        language="markdown"
        theme={ESE_THEME}
        value={doc.content}
        onChange={(value) => setContent(value ?? "")}
        options={SOURCE_OPTIONS}
      />
    </div>
  );

  const previewPane = (
    <div
      className="note-editor__preview md-preview"
      data-testid="note-preview"
      dangerouslySetInnerHTML={{
        __html: previewHtml || "<p class='md-empty'>Пустая заметка — переключитесь в режим правки.</p>",
      }}
    />
  );

  return (
    <div className="note-editor">
      <div className="note-toolbar">
        <span className="note-toolbar__path mono" title={doc.path}>
          {doc.path}
          {dirty && <span className="note-toolbar__dirty" title="Есть несохранённые изменения"> ●</span>}
        </span>
        <div className="view-mode" role="group" aria-label="Режим редактора заметки">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`view-mode__btn${mode === m.id ? " view-mode__btn--active" : ""}`}
              title={m.title}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="note-toolbar__spacer" />
        {notice && (
          <span className="note-toolbar__notice" role="status" onClick={dismissNotice}>
            {notice}
          </span>
        )}
        <button
          type="button"
          className="btn btn--small"
          disabled={saving || (!dirty && !conflict)}
          onClick={() => void save()}
          title="Сохранить исходный Markdown (Ctrl+S)"
        >
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
      </div>

      {conflict && (
        <div className="nb-banner nb-banner--error" role="alert">
          Файл изменён на диске после открытия (например, кодом из ядра блокнота или внешним
          редактором).{" "}
          <button type="button" className="btn btn--small" onClick={() => void reload()}>
            Перезагрузить с диска
          </button>{" "}
          <button
            type="button"
            className="btn btn--small btn--danger"
            onClick={() => void save({ force: true })}
          >
            Перезаписать
          </button>
        </div>
      )}
      {error && (
        <div className="nb-banner nb-banner--error" role="alert" onClick={clearError}>
          {error.message}
          {error.hint && <span className="workspace-error__hint"> {error.hint}</span>}
        </div>
      )}

      <div className="note-editor__body">
        {mode === "wysiwyg" && (
          <CrepeHost
            key={`${doc.path}#${reloadToken}`}
            initialContent={doc.content}
            onChange={setContent}
            projectId={projectId}
            notePath={doc.path}
          />
        )}
        {mode === "source" && sourcePane}
        {mode === "preview" && previewPane}
        {mode === "split" && (
          <Allotment>
            <Allotment.Pane minSize={220}>{sourcePane}</Allotment.Pane>
            <Allotment.Pane minSize={220}>{previewPane}</Allotment.Pane>
          </Allotment>
        )}
      </div>

      <div className="note-editor__statusbar mono" title="Исходный Markdown на диске — единственный источник истины">
        {doc.path} · {new Blob([doc.content]).size} Б · режим: {mode}
        {dirty ? " · не сохранено" : ""}
      </div>
    </div>
  );
}
