import { useMemo, useState } from "react";

import type { FileSummary } from "../../api/types";
import { formatBytes } from "../../monaco/helpers";
import { buildFileTree, treeMatchesQuery } from "./tree";
import type { TreeNode } from "./tree";

const LANG_BADGE: Record<string, string> = {
  python: "py",
  javascript: "js",
  typescript: "ts",
  tsx: "tsx",
  markdown: "md",
};

interface FileTreeProps {
  files: FileSummary[];
  selectedFileId: string | null;
  query: string;
  onSelect: (fileId: string) => void;
}

function TreeNodeRow({
  node,
  depth,
  selectedFileId,
  onSelect,
  collapsed,
  toggle,
}: {
  node: TreeNode;
  depth: number;
  selectedFileId: string | null;
  onSelect: (fileId: string) => void;
  collapsed: Set<string>;
  toggle: (path: string) => void;
}) {
  if (node.isDir) {
    const isCollapsed = collapsed.has(node.path);
    return (
      <li role="none">
        <div
          className="tree-row tree-row--dir"
          style={{ paddingLeft: 8 + depth * 12 }}
          role="treeitem"
          aria-expanded={!isCollapsed}
          tabIndex={0}
          onClick={() => toggle(node.path)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle(node.path);
            }
          }}
        >
          <span className="tree-row__chevron" aria-hidden="true">
            {isCollapsed ? "▸" : "▾"}
          </span>
          <span className="tree-row__name">{node.name}</span>
        </div>
        {!isCollapsed && (
          <ul role="group">
            {node.children.map((child) => (
              <TreeNodeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedFileId={selectedFileId}
                onSelect={onSelect}
                collapsed={collapsed}
                toggle={toggle}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const file = node.file;
  if (!file) return null;
  const selected = file.id === selectedFileId;
  const badge = file.language ? (LANG_BADGE[file.language] ?? file.language.slice(0, 2)) : "··";
  return (
    <li role="none">
      <div
        className={`tree-row tree-row--file${selected ? " tree-row--selected" : ""}${
          file.status === "error" ? " tree-row--error" : ""
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
        role="treeitem"
        aria-selected={selected}
        tabIndex={0}
        title={`${file.rel_path}\n${file.fragment_count} фрагментов · ${formatBytes(file.size)}${
          file.status === "error" ? `\nошибка: ${file.detail ?? "?"}` : ""
        }`}
        onClick={() => onSelect(file.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(file.id);
          }
        }}
      >
        <span className={`tree-row__badge lang-${file.language ?? "text"}`}>{badge}</span>
        <span className="tree-row__name">{node.name}</span>
        <span className="tree-row__count">{file.fragment_count > 0 ? file.fragment_count : ""}</span>
      </div>
    </li>
  );
}

export function FileTree({ files, selectedFileId, query, onSelect }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildFileTree(files), [files]);

  const visible = useMemo(() => {
    if (!query.trim()) return tree;
    return tree.filter((node) => treeMatchesQuery(node, query.trim()));
  }, [tree, query]);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (files.length === 0) {
    return (
      <div className="empty-hint">
        Файлов нет. Запустите индексирование — кнопка «Индексировать» сверху.
      </div>
    );
  }
  if (visible.length === 0) {
    return <div className="empty-hint">Ничего не найдено по фильтру «{query}».</div>;
  }

  return (
    <ul className="file-tree" role="tree" aria-label="Дерево файлов проекта">
      {visible.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          selectedFileId={selectedFileId}
          onSelect={onSelect}
          collapsed={collapsed}
          toggle={toggle}
        />
      ))}
    </ul>
  );
}