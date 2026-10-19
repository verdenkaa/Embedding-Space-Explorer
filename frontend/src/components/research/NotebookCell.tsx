import { Editor } from "@monaco-editor/react";
import { useMemo } from "react";

import type { NotebookCellJson } from "../../api/types";
import { ESE_THEME } from "../../monaco/helpers";
import { renderMarkdown } from "../../markdown/renderMarkdown";
import { cellSourceString } from "../../state/notebookStore";
import { CellOutputs } from "./CellOutputs";

interface NotebookCellProps {
  cell: NotebookCellJson;
  index: number;
  selected: boolean;
  editing: boolean;
  running: boolean;
  onSelect: () => void;
  onSourceChange: (source: string) => void;
  onRun: () => void;
  onAddBelow: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onConvert: (type: "code" | "markdown") => void;
  onEditingChange: (editing: boolean) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

/** Monaco grows with content up to a cap (cells scroll internally beyond it). */
function editorHeight(source: string): number {
  const lines = source.split("\n").length;
  return Math.min(480, Math.max(58, lines * 18 + 22));
}

const COMMON_OPTIONS = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineHeight: 18,
  tabSize: 4,
  automaticLayout: true,
  padding: { top: 6, bottom: 6 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  overviewRulerLanes: 0,
  lineDecorationsWidth: 4,
  renderLineHighlight: "none" as const,
  folding: false,
  glyphMargin: false,
};

export function NotebookCell(props: NotebookCellProps) {
  const {
    cell,
    index,
    selected,
    editing,
    running,
    onSelect,
    onSourceChange,
    onRun,
    onAddBelow,
    onDelete,
    onMove,
    onConvert,
    onEditingChange,
    canMoveUp,
    canMoveDown,
  } = props;

  const source = useMemo(() => cellSourceString(cell), [cell]);
  const isCode = cell.cell_type === "code";
  const previewHtml = useMemo(
    () => (isCode || editing ? "" : renderMarkdown(source)),
    [isCode, editing, source],
  );

  const countLabel =
    isCode && typeof cell.execution_count === "number" ? `[${cell.execution_count}]` : isCode ? "[ ]" : "";

  return (
    <div
      className={`nb-cell${selected ? " nb-cell--selected" : ""}${isCode ? "" : " nb-cell--markdown"}`}
      data-testid={`nb-cell-${index}`}
      onClick={onSelect}
      role="group"
      aria-label={`Ячейка ${index + 1}: ${isCode ? "код" : "markdown"}`}
    >
      <div className="nb-cell__gutter">
        <span className="nb-cell__count mono" title="Порядковый номер выполнения">
          {countLabel}
        </span>
        {isCode && (
          <button
            type="button"
            className="nb-cell__run"
            title={running ? "Выполняется…" : "Выполнить ячейку (Ctrl+Enter)"}
            disabled={running}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
              onRun();
            }}
          >
            {running ? "…" : "▶"}
          </button>
        )}
      </div>

      <div className="nb-cell__body">
        <div className="nb-cell__toolbar">
          <span className="nb-cell__type">{isCode ? "code" : "markdown"}</span>
          <div className="nb-cell__spacer" />
          <button
            type="button"
            className="nb-cell__tool"
            title="Вверх"
            disabled={!canMoveUp}
            onClick={(e) => {
              e.stopPropagation();
              onMove(-1);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="nb-cell__tool"
            title="Вниз"
            disabled={!canMoveDown}
            onClick={(e) => {
              e.stopPropagation();
              onMove(1);
            }}
          >
            ↓
          </button>
          <button
            type="button"
            className="nb-cell__tool"
            title="Добавить ячейку ниже"
            onClick={(e) => {
              e.stopPropagation();
              onAddBelow();
            }}
          >
            +
          </button>
          <button
            type="button"
            className="nb-cell__tool"
            title={isCode ? "Превратить в markdown" : "Превратить в код"}
            onClick={(e) => {
              e.stopPropagation();
              onConvert(isCode ? "markdown" : "code");
            }}
          >
            {isCode ? "md" : "</>"}
          </button>
          <button
            type="button"
            className="nb-cell__tool nb-cell__tool--danger"
            title="Удалить ячейку"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            🗑
          </button>
        </div>

        {isCode ? (
          <div className="nb-cell__editor" data-testid={`nb-code-editor-${index}`}>
            <Editor
              height={editorHeight(source)}
              language="python"
              theme={ESE_THEME}
              value={source}
              onChange={(value) => onSourceChange(value ?? "")}
              onMount={(editor, monaco) => {
                // Cell-local shortcuts so Monaco does not swallow them.
                editor.addCommand(
                  monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                  () => onRun(),
                );
              }}
              options={COMMON_OPTIONS}
            />
          </div>
        ) : editing ? (
          <div className="nb-cell__editor" data-testid={`nb-md-editor-${index}`}>
            <Editor
              height={editorHeight(source)}
              language="markdown"
              theme={ESE_THEME}
              value={source}
              onChange={(value) => onSourceChange(value ?? "")}
              onMount={(editor, monaco) => {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
                  onEditingChange(false),
                );
                editor.addCommand(monaco.KeyCode.Escape, () => onEditingChange(false));
              }}
              options={{ ...COMMON_OPTIONS, lineNumbers: "off" }}
            />
          </div>
        ) : (
          <div
            className="nb-cell__preview md-preview"
            data-testid={`nb-md-preview-${index}`}
            title="Двойной клик — редактировать"
            onDoubleClick={() => onEditingChange(true)}
            dangerouslySetInnerHTML={{ __html: previewHtml || "<p class='md-empty'>Пустая markdown-ячейка — двойной клик для редактирования</p>" }}
          />
        )}

        {!isCode && editing && (
          <div className="nb-cell__md-hint">
            <button
              type="button"
              className="btn btn--small"
              onClick={(e) => {
                e.stopPropagation();
                onEditingChange(false);
              }}
            >
              Предпросмотр (Ctrl+Enter)
            </button>
            <span className="nb-cell__md-formula-hint">
              Формулы: <span className="mono">$…$</span> и{" "}
              <span className="mono">$$…$$</span> (KaTeX)
            </span>
          </div>
        )}

        {isCode && <CellOutputs outputs={(cell.outputs ?? []) as never} />}
      </div>
    </div>
  );
}
