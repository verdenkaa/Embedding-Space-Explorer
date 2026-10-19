import { useCallback, useEffect, useMemo, useState } from "react";

import { useProjectStore } from "../../state/projectStore";
import { cellKey, useNotebookStore } from "../../state/notebookStore";
import { NotebookCell } from "./NotebookCell";

const KERNEL_LABEL: Record<string, string> = {
  starting: "ядро запускается…",
  ready: "ядро готово",
  restarting: "перезапуск ядра…",
  dead: "ядро завершилось",
  error: "ошибка ядра",
};

/**
 * Notebook editor: toolbar (save/run/kernel), project-binding banner,
 * validation banner and the cell list. The document itself lives in
 * notebookStore (server-backed .ipynb), never in localStorage.
 */
export function NotebookEditor({ projectId, path }: { projectId: string; path: string }) {
  const doc = useNotebookStore((s) => s.doc);
  const dirty = useNotebookStore((s) => s.dirty);
  const saving = useNotebookStore((s) => s.saving);
  const loading = useNotebookStore((s) => s.loading);
  const problems = useNotebookStore((s) => s.problems);
  const conflict = useNotebookStore((s) => s.conflict);
  const error = useNotebookStore((s) => s.error);
  const session = useNotebookStore((s) => s.session);
  const runningCell = useNotebookStore((s) => s.runningCell);
  const selectedCell = useNotebookStore((s) => s.selectedCell);
  const editing = useNotebookStore((s) => s.editing);
  const open = useNotebookStore((s) => s.open);
  const save = useNotebookStore((s) => s.save);
  const setCellSource = useNotebookStore((s) => s.setCellSource);
  const addCell = useNotebookStore((s) => s.addCell);
  const deleteCell = useNotebookStore((s) => s.deleteCell);
  const moveCell = useNotebookStore((s) => s.moveCell);
  const convertCell = useNotebookStore((s) => s.convertCell);
  const setSelectedCell = useNotebookStore((s) => s.setSelectedCell);
  const setEditing = useNotebookStore((s) => s.setEditing);
  const executeCell = useNotebookStore((s) => s.executeCell);
  const executeCells = useNotebookStore((s) => s.executeCells);
  const stopExecution = useNotebookStore((s) => s.stopExecution);
  const restartKernel = useNotebookStore((s) => s.restartKernel);
  const shutdownSession = useNotebookStore((s) => s.shutdownSession);
  const clearAllOutputs = useNotebookStore((s) => s.clearAllOutputs);
  const clearError = useNotebookStore((s) => s.clearError);

  const [restarting, setRestarting] = useState(false);

  /* (Re)load the document whenever a different notebook/project is opened. */
  useEffect(() => {
    void open(projectId, path);
  }, [projectId, path, open]);

  /* Warn before closing the browser tab with unsaved changes. */
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const runSelected = useCallback(() => {
    void executeCell(selectedCell);
  }, [executeCell, selectedCell]);

  /* Global shortcuts while the editor is mounted: Ctrl+S save,
     Ctrl+Enter run selected, Shift+Enter run + select next. */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        runSelected();
      } else if (e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        const store = useNotebookStore.getState();
        void store.executeCell(store.selectedCell).then(() => {
          const cells = useNotebookStore.getState().doc?.notebook.cells ?? [];
          const next = Math.min(store.selectedCell + 1, cells.length - 1);
          store.setSelectedCell(next);
        });
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [save, runSelected]);

  const eseProjectId = useMemo(() => {
    const ese = doc?.notebook.metadata?.["ese"];
    if (ese && typeof ese === "object" && "project_id" in ese) {
      return String((ese as { project_id?: unknown }).project_id ?? "");
    }
    return null;
  }, [doc]);

  const currentProjectId = useProjectStore((s) => s.current?.id ?? null);
  const foreignProject = eseProjectId !== null && currentProjectId !== null && eseProjectId !== currentProjectId;

  if (loading && !doc) {
    return <div className="notebook-editor"><div className="empty-hint empty-hint--center">Загрузка блокнота…</div></div>;
  }
  if (!doc) {
    return (
      <div className="notebook-editor">
        <div className="empty-hint empty-hint--center">
          {error ? error.message : "Блокнот не открыт."}
        </div>
      </div>
    );
  }

  const cells = doc.notebook.cells;
  const kernelState = session?.state ?? null;
  const busy = runningCell !== null;

  const onRestart = async () => {
    setRestarting(true);
    await restartKernel();
    setRestarting(false);
  };

  return (
    <div className="notebook-editor">
      <div className="nb-toolbar">
        <span className="nb-toolbar__path mono" title={doc.path}>
          {doc.path}
          {dirty && <span className="nb-toolbar__dirty" title="Есть несохранённые изменения"> ●</span>}
        </span>
        <span
          className={`nb-toolbar__kernel nb-toolbar__kernel--${kernelState ?? "none"}`}
          title={session?.error ?? (kernelState ? KERNEL_LABEL[kernelState] : "Ядро не запущено — начнётся при первом выполнении")}
        >
          {busy ? "выполнение…" : kernelState ? KERNEL_LABEL[kernelState] : "нет ядра"}
        </span>
        <div className="nb-toolbar__spacer" />
        <button type="button" className="btn btn--small" disabled={saving || !dirty} onClick={() => void save()} title="Ctrl+S">
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
        <button type="button" className="btn btn--small" disabled={busy} onClick={runSelected} title="Выполнить выбранную ячейку (Ctrl+Enter)">
          ▶ Выполнить
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || cells.length === 0}
          title="Выполнить все ячейки подряд (сверху вниз)"
          onClick={() => void executeCells(cells.map((_, i) => i))}
        >
          ▶▶ Все
        </button>
        <button type="button" className="btn btn--small" disabled={!busy} onClick={() => void stopExecution()} title="Прервать выполнение (KeyboardInterrupt)">
          ⏹ Стоп
        </button>
        <button type="button" className="btn btn--small" disabled={restarting} onClick={() => void onRestart()} title="Перезапустить ядро — состояние Python сбросится">
          ⟳ Ядро
        </button>
        <button type="button" className="btn btn--small" disabled={!session} onClick={() => void shutdownSession()} title="Остановить ядро и освободить ресурсы">
          ⏻ Остановить ядро
        </button>
        <button type="button" className="btn btn--small" onClick={clearAllOutputs} title="Очистить выводы и номера выполнения всех ячеек">
          🧹 Выводы
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => addCell(cells.length - 1, "code")}
          title="Добавить code-ячейку в конец"
        >
          + Ячейка
        </button>
      </div>

      {foreignProject && (
        <div className="nb-banner nb-banner--warn" role="status">
          Блокнот создан для другого проекта (<span className="mono">{eseProjectId}</span>). Ядро
          выполняет код в контексте ТЕКУЩЕГО проекта: <span className="mono">ese.project.current()</span>{" "}
          вернёт проект, в котором блокнот открыт сейчас.
        </div>
      )}
      {problems.length > 0 && (
        <div className="nb-banner nb-banner--warn" role="status">
          Файл не полностью соответствует формату .ipynb ({problems.length} замечаний). Открыто для
          просмотра; сохранение нормализует структуру. Первое замечание: {problems[0].slice(0, 160)}
        </div>
      )}
      {conflict && (
        <div className="nb-banner nb-banner--error" role="alert">
          Файл изменён на диске после открытия (например, ядром или внешним редактором).{" "}
          <button type="button" className="btn btn--small" onClick={() => void open(projectId, path)}>
            Перезагрузить с диска
          </button>{" "}
          <button type="button" className="btn btn--small btn--danger" onClick={() => void save({ force: true })}>
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

      <div className="nb-cells">
        {cells.length === 0 && (
          <div className="empty-hint empty-hint--center">
            Пустой блокнот — добавьте первую ячейку кнопкой «+ Ячейка».
          </div>
        )}
        {cells.map((cell, index) => (
          <NotebookCell
            key={cellKey(cell, index)}
            cell={cell}
            index={index}
            selected={index === selectedCell}
            editing={editing[cellKey(cell, index)] ?? (cell.cell_type === "code")}
            running={runningCell === index}
            canMoveUp={index > 0}
            canMoveDown={index < cells.length - 1}
            onSelect={() => setSelectedCell(index)}
            onSourceChange={(source) => setCellSource(index, source)}
            onRun={() => void executeCell(index)}
            onAddBelow={() => addCell(index, "code")}
            onDelete={() => deleteCell(index)}
            onMove={(direction) => moveCell(index, direction)}
            onConvert={(type) => convertCell(index, type)}
            onEditingChange={(value) => setEditing(cellKey(cell, index), value)}
          />
        ))}
      </div>
    </div>
  );
}
