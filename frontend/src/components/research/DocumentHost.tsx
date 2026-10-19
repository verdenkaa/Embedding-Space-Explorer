import { useResearchStore } from "../../state/researchStore";

function formatMtime(mtime: number): string {
  if (!mtime) return "";
  return new Date(mtime * 1000).toLocaleString();
}

/**
 * Right pane of the RESEARCH section: hosts the open document.
 *
 * Stage 2 shows a read-only viewer (files are real, on disk, editable via the
 * tree operations). The Notebook editor (.ipynb) and the Markdown note editor
 * mount here in the next stages, replacing the viewer by file type.
 */
export function DocumentHost() {
  const selectedPath = useResearchStore((s) => s.selectedPath);
  const file = useResearchStore((s) => s.file);
  const fileLoading = useResearchStore((s) => s.fileLoading);
  const tree = useResearchStore((s) => s.tree);

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
