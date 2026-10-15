/**
 * Pure helpers to build a file tree from the flat file list.
 * Kept separate from the component for unit testing.
 */

import type { FileSummary } from "../../api/types";

export interface TreeNode {
  /** Display name (last path segment). */
  name: string;
  /** Full POSIX-style path relative to the tree root ("src" or "src/app.py"). */
  path: string;
  isDir: boolean;
  file?: FileSummary;
  children: TreeNode[];
}

export function buildFileTree(files: FileSummary[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirIndex = new Map<string, TreeNode>();
  dirIndex.set("", root);

  const sorted = [...files].sort((a, b) => a.rel_path.localeCompare(b.rel_path));
  for (const file of sorted) {
    const segments = file.rel_path.split("/");
    let parentPath = "";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      if (isLast) {
        const node: TreeNode = { name: segment, path, isDir: false, file, children: [] };
        const parent = dirIndex.get(parentPath);
        parent?.children.push(node);
      } else {
        let dir = dirIndex.get(path);
        if (!dir) {
          dir = { name: segment, path, isDir: true, children: [] };
          dirIndex.set(path, dir);
          const parent = dirIndex.get(parentPath);
          parent?.children.push(dir);
        }
        parentPath = path;
      }
    }
  }

  sortTree(root.children);
  return root.children;
}

function sortTree(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.isDir) sortTree(node.children);
  }
}

/** Paths that stay visible when filtering by a substring query. */
export function treeMatchesQuery(node: TreeNode, query: string): boolean {
  const q = query.toLowerCase();
  if (node.isDir) {
    return node.children.some((child) => treeMatchesQuery(child, q));
  }
  return node.path.toLowerCase().includes(q);
}
