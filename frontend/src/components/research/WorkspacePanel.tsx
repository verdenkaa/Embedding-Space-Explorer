import { useEffect, useMemo, useState } from "react";

import type { WorkspaceEntryKind } from "../../api/types";
import { useProjectStore } from "../../state/projectStore";
import { useResearchStore } from "../../state/researchStore";
import { CreateDialog, DeleteDialog, RenameDialog } from "./ResearchDialogs";
import type { CreateKind } from "./researchFiles";
import { WorkspaceTree } from "./WorkspaceTree";

type DialogState =
  | { type: "create"; kind: CreateKind }
  | { type: "rename"; path: string }
  | { type: "delete"; path: string; isDir: boolean }
  | null;

/**
 * Left panel of the RESEARCH section: workspace file tree + file operations.
 * The workspace is a separate file space from the corpus (documents are never
 * indexed into embeddings); the tree component follows the SPACE panel look.
 */
export function WorkspacePanel() {
  const current = useProjectStore((s) => s.current);
  const tree = useResearchStore((s) => s.tree);
  const treeRoot = useResearchStore((s) => s.treeRoot);
  const treeTruncated = useResearchStore((s) => s.treeTruncated);
  const treeLoading = useResearchStore((s) => s.treeLoading);
  const selectedPath = useResearchStore((s) => s.selectedPath);
  const busy = useResearchStore((s) => s.busy);
  const loadTree = useResearchStore((s) => s.loadTree);
  const selectPath = useResearchStore((s) => s.selectPath);
  const createPath = useResearchStore((s) => s.createPath);
  const renamePath = useResearchStore((s) => s.renamePath);
  const deletePath = useResearchStore((s) => s.deletePath);
  const openFolder = useResearchStore((s) => s.openFolder);

  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const selectedEntry = useMemo(
    () => (tree ?? []).find((e) => e.path === selectedPath) ?? null,
    [tree, selectedPath],
  );

  if (!current) return null;

  const onCreate = async (path: string, kind: WorkspaceEntryKind, content: string) =>
    createPath(path, kind, content);

  return (
    <section className="workspace-panel" aria-label="Рабочее пространство проекта">
      <div className="corpus-toolbar">
        <span className="corpus-toolbar__project" title={treeRoot ?? ""}>
          workspace
        </span>
        <div className="corpus-toolbar__spacer" />
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          title="Обновить дерево файлов"
          onClick={() => void loadTree()}
        >
          ⟳
        </button>
        <button
          type="button"
          className="btn btn--small"
          title="Открыть папку рабочего пространства в файловом менеджере ОС"
          onClick={() => void openFolder("")}
        >
          🗀 Папка
        </button>
      </div>

      <div className="workspace-toolbar">
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={() => setDialog({ type: "create", kind: "notebook" })}
        >
          + Блокнот
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={() => setDialog({ type: "create", kind: "note" })}
        >
          + Заметка
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={() => setDialog({ type: "create", kind: "dir" })}
        >
          + Папка
        </button>
        <div className="corpus-toolbar__spacer" />
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || !selectedPath}
          title={selectedPath ? `Переименовать ${selectedPath}` : "Сначала выберите файл или папку"}
          onClick={() => selectedPath && setDialog({ type: "rename", path: selectedPath })}
        >
          Переименовать
        </button>
        <button
          type="button"
          className="btn btn--small btn--danger"
          disabled={busy || !selectedEntry}
          title={selectedPath ? `Удалить ${selectedPath}` : "Сначала выберите файл или папку"}
          onClick={() =>
            selectedEntry &&
            setDialog({ type: "delete", path: selectedEntry.path, isDir: selectedEntry.kind === "dir" })
          }
        >
          Удалить
        </button>
      </div>

      <div className="corpus-search">
        <input
          className="create-form__input mono"
          placeholder="фильтр по имени…"
          value={query}
          spellCheck={false}
          aria-label="Фильтр дерева документов"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="workspace-panel__tree">
        {treeLoading && !tree ? (
          <div className="empty-hint">Загрузка рабочего пространства…</div>
        ) : (
          <WorkspaceTree
            entries={tree ?? []}
            selectedPath={selectedPath}
            query={query}
            onSelectFile={(path) => void selectPath(path)}
            onSelectDir={(path) => void selectPath(path)}
          />
        )}
      </div>

      <div className="workspace-panel__footer mono" title={treeRoot ?? ""}>
        {treeTruncated ? "список обрезан (слишком много файлов) · " : ""}
        {treeRoot ?? ""}
      </div>

      {dialog?.type === "create" && (
        <CreateDialog
          kind={dialog.kind}
          projectId={current.id}
          onCreate={onCreate}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "rename" && (
        <RenameDialog
          path={dialog.path}
          onRename={renamePath}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "delete" && (
        <DeleteDialog
          path={dialog.path}
          isDir={dialog.isDir}
          onDelete={deletePath}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
