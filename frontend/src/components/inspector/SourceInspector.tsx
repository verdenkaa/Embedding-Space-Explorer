import { Editor } from "@monaco-editor/react";
import { useEffect, useMemo, useRef } from "react";

import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";

import { useProjectStore } from "../../state/projectStore";
import {
  ESE_THEME,
  computeDecorations,
  kindBadge,
  kindColorClass,
  monacoLanguageFor,
} from "../../monaco/helpers";

const SELECTION_DEBOUNCE_MS = 300;

/**
 * Right panel: read-only Monaco viewer with fragment highlighting and
 * reverse tracing — selecting lines locates all intersecting fragments
 * (TZ §6.4, UI-ТЗ §6).
 */
export function SourceInspector() {
  const fileContent = useProjectStore((s) => s.fileContent);
  const fileDetail = useProjectStore((s) => s.fileDetail);
  const activeFragmentId = useProjectStore((s) => s.activeFragmentId);
  const locatedFragments = useProjectStore((s) => s.locatedFragments);
  const locatedNote = useProjectStore((s) => s.locatedNote);
  const selectFragment = useProjectStore((s) => s.selectFragment);
  const locateFromEditorSelection = useProjectStore((s) => s.locateFromEditorSelection);

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const debounceRef = useRef<number | null>(null);

  const activeFragment = useMemo(
    () => fileDetail?.fragments.find((f) => f.id === activeFragmentId) ?? null,
    [fileDetail, activeFragmentId],
  );

  /* (Re)build decorations when the file or the active fragment changes. */
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !fileDetail) return;
    const specs = computeDecorations(fileDetail.fragments, activeFragmentId).map((d) => ({
      range: new monaco.Range(d.range.startLine, 1, d.range.endLine, 1),
      options: {
        isWholeLine: true,
        className: d.className,
        glyphMarginClassName: d.glyphClassName,
      },
    }));
    if (decorationsRef.current) {
      decorationsRef.current.set(specs);
    } else {
      decorationsRef.current = editor.createDecorationsCollection(specs);
    }
  }, [fileDetail, activeFragmentId]);

  /* Scroll the active fragment into view. */
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !activeFragment) return;
    editor.revealRangeInCenterIfOutsideViewport(
      new monaco.Range(activeFragment.start_line, 1, activeFragment.end_line, 1),
    );
  }, [activeFragment]);

  const language = monacoLanguageFor(fileContent?.language ?? null);

  if (!fileContent) {
    return (
      <section className="source-inspector" aria-label="Исходный код">
        <div className="empty-hint empty-hint--center">
          Выберите файл в дереве слева — здесь откроется его содержимое с подсветкой
          диапазонов фрагментов.
        </div>
      </section>
    );
  }

  return (
    <section className="source-inspector" aria-label="Исходный код">
      <header className="source-inspector__header">
        <span className="source-inspector__path mono" title={fileContent.rel_path}>
          {fileContent.rel_path}
        </span>
        <span className="source-inspector__meta mono">
          {fileContent.total_lines} строк · {language} · только просмотр
        </span>
      </header>

      {locatedFragments !== null && (
        <div className="locator-bar" role="status" aria-label="Фрагменты в выделении">
          <span className="locator-bar__label">Фрагменты в выделении:</span>
          {locatedFragments.length === 0 && (
            <span className="locator-bar__none">нет пересекающихся фрагментов</span>
          )}
          {locatedFragments.map((fragment) => (
            <button
              key={fragment.id}
              type="button"
              className={`locator-chip ${kindColorClass(fragment.kind)}${
                fragment.id === activeFragmentId ? " locator-chip--active" : ""
              }`}
              onClick={() => void selectFragment(fragment)}
              title={`${fragment.symbol_path} · строки ${fragment.start_line}-${fragment.end_line}`}
            >
              <span className="locator-chip__kind">{kindBadge(fragment.kind)}</span>
              {fragment.name ?? fragment.symbol_path}
              <span className="locator-chip__lines mono">
                {fragment.start_line}–{fragment.end_line}
              </span>
            </button>
          ))}
          {locatedFragments.length > 1 && locatedNote && (
            <span className="locator-bar__note" title={locatedNote}>
              ⓘ {locatedFragments.length} пересечения
            </span>
          )}
        </div>
      )}

      <div className="source-inspector__editor">
        <Editor
          value={fileContent.content}
          path={fileContent.rel_path}
          language={language}
          theme={ESE_THEME}
          loading={<div className="empty-hint empty-hint--center">Загрузка редактора…</div>}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
            decorationsRef.current = null;
            editor.onDidChangeCursorSelection((event) => {
              if (debounceRef.current !== null) {
                window.clearTimeout(debounceRef.current);
              }
              const { startLineNumber, endLineNumber } = event.selection;
              debounceRef.current = window.setTimeout(() => {
                void locateFromEditorSelection(startLineNumber, endLineNumber);
              }, SELECTION_DEBOUNCE_MS);
            });
          }}
          options={{
            readOnly: true,
            domReadOnly: true,
            // Follow container resizes (Allotment sash drags, window resize).
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, 'JetBrains Mono', monospace",
            lineNumbers: "on",
            glyphMargin: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: "all",
            smoothScrolling: true,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>
    </section>
  );
}
