import { useProjectStore } from "../../state/projectStore";
import { useResearchStore } from "../../state/researchStore";
import { NotebookEditor } from "./NotebookEditor";

function formatMtime(mtime: number): string {
  if (!mtime) return "";
  return new Date(mtime * 1000).toLocaleString();
}

/**
 * Right pane of the RESEARCH section: hosts the open document.
 *
 * .ipynb → the Notebook editor (kernel sessions, cells, outputs).
 * Other text files → read-only viewer for now; the Markdown note editor
 * mounts here in the next stage.
 */
export function DocumentHost() {
  const projectId = useProjectStore((s) => s.current?.id ?? null);
  const selectedPath = useResearchStore((s) => s.selectedPath);
  const file = useResearchStore((s) => s.file);
  const fileLoading = useResearchStore((s) => s.fileLoading);
  const tree = useResearchStore((s) => s.tree);

  if (selectedPath?.toLowerCase().endsWith(".ipynb") && projectId) {
    // The notebook document is owned by notebookStore (not researchStore.file):
    // cells/outputs live in the .ipynb, never in the generic text buffer.
    return <NotebookEditor projectId={projectId} path={selectedPath} />;
  }

  if (!selectedPath) {
    return (
      <div className="document-host">
        <div className="empty-hint empty-hint--center">
          <p>
            Рабочее пространство проекта: <span className="mono">notebooks/</span>,{" "}
            <span className="mono">notes/</span>, <span className="mono">datasets/</span>,{" "}
            <span className="mono">results/</span>, <span className="mono">exports/</span>.
          </p>
          <p>
            Файлы хранятся на диске внутри каталога проекта и НЕ входят в индексируемый
            embedding-корпус. Выберите файл в дереве слева.
          </p>
        </div>
      </div>
    );
  }

  const entry = (tree ?? []).find((e) => e.path === selectedPath);
  if (entry?.kind === "dir") {
    return (
      <div className="document-host">
        <div className="empty-hint empty-hint--center">
          <p className="mono">{selectedPath}/</p>
          <p>
            Выбрана папка. Кнопки «Переименовать» и «Удалить» на левой панели применяются
            к ней.
          </p>
        </div>
      </div>
    );
  }

  if (fileLoading || !file) {
    return (
      <div className="document-host">
        <div className="empty-hint empty-hint--center">Загрузка файла…</div>
      </div>
    );
  }

  return (
    <div className="document-host">
      <div className="document-host__header">
        <span className="document-host__path mono" title={file.path}>
          {file.path}
        </span>
        <span className="document-host__meta">
          {file.size} Б{file.mtime ? ` · ${formatMtime(file.mtime)}` : ""}
        </span>
      </div>
      <pre className="document-host__pre mono" aria-label="Содержимое файла (только просмотр)">
        {file.content}
      </pre>
    </div>
  );
}
