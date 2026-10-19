import { useMemo, useState } from "react";

import type { WorkspaceEntry } from "../../api/types";
import {
  badgeFor,
  buildWorkspaceTree,
  filterWorkspaceTree,
} from "./researchTree";
import type { WorkspaceTreeNode } from "./researchTree";

interface WorkspaceTreeProps {
  entries: WorkspaceEntry[];
  selectedPath: string | null;
  query: string;
  onSelectFile: (path: string) => void;
  onSelectDir: (path: string) => void;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function NodeRow({
  node,
  depth,
  selectedPath,
  onSelectFile,
  onSelectDir,
  collapsed,
  toggle,
}: {
  node: WorkspaceTreeNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  onSelectDir: (path: string) => void;
  collapsed: Set<string>;
  toggle: (path: string) => void;
}) {
  if (node.isDir) {
    const isCollapsed = collapsed.has(node.path);
    const selected = node.path === selectedPath;
    return (
      <li role="none">
        <div
          className={`tree-row tree-row--dir${selected ? " tree-row--selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          role="treeitem"
          aria-expanded={!isCollapsed}
          aria-selected={selected}
          tabIndex={0}
          onClick={() => {
            toggle(node.path);
            onSelectDir(node.path);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle(node.path);
              onSelectDir(node.path);
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
              <NodeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                onSelectDir={onSelectDir}
                collapsed={collapsed}
                toggle={toggle}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const selected = node.path === selectedPath;
  const badge = badgeFor(node.name);
  const size = node.entry ? formatSize(node.entry.size) : "";
  return (
    <li role="none">
      <div
        className={`tree-row tree-row--file${selected ? " tree-row--selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        role="treeitem"
        aria-selected={selected}
        tabIndex={0}
        title={`${node.path}${size ? ` · ${size}` : ""}`}
        onClick={() => onSelectFile(node.path)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelectFile(node.path);
          }
        }}
      >
        <span className={`tree-row__badge ${badge.className}`}>{badge.text}</span>
        <span className="tree-row__name">{node.name}</span>
      </div>
    </li>
  );
}

export function WorkspaceTree({
  entries,
  selectedPath,
  query,
  onSelectFile,
  onSelectDir,
}: WorkspaceTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildWorkspaceTree(entries), [entries]);
  const visible = useMemo(() => filterWorkspaceTree(tree, query), [tree, query]);

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (entries.length === 0) {
    return (
      <div className="empty-hint">
        Рабочее пространство пусто. Создайте блокнот или заметку кнопками выше.
      </div>
    );
  }
  if (visible.length === 0) {
    return <div className="empty-hint">Ничего не найдено по фильтру «{query}».</div>;
  }

  return (
    <ul className="file-tree" role="tree" aria-label="Дерево исследовательских файлов">
      {visible.map((node) => (
        <NodeRow
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onSelectDir={onSelectDir}
          collapsed={collapsed}
          toggle={toggle}
        />
      ))}
    </ul>
  );
}
