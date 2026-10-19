/**
 * Pure helpers to build a document tree from the flat workspace listing.
 * Mirrors corpus/tree.ts conventions but is typed for WorkspaceEntry
 * (the workspace is a separate file space — the corpus tree is untouched).
 */

import type { WorkspaceEntry } from "../../api/types";

export interface WorkspaceTreeNode {
  /** Display name (last path segment). */
  name: string;
  /** Full POSIX-style path relative to the workspace root. */
  path: string;
  isDir: boolean;
  entry?: WorkspaceEntry;
  children: WorkspaceTreeNode[];
}

export function buildWorkspaceTree(entries: WorkspaceEntry[]): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirIndex = new Map<string, WorkspaceTreeNode>();
  dirIndex.set("", root);

  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const segments = entry.path.split("/");
    let parentPath = "";
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      if (isLast) {
        const node: WorkspaceTreeNode = {
          name: segment,
          path,
          isDir: entry.kind === "dir",
          entry,
          children: [],
        };
        const parent = dirIndex.get(parentPath);
        parent?.children.push(node);
        if (node.isDir) dirIndex.set(path, node);
      } else {
        let dir = dirIndex.get(path);
        if (!dir) {
          // Implicit directory (backend lists dirs, but be robust).
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

function sortTree(nodes: WorkspaceTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.isDir) sortTree(node.children);
  }
}

/** Keep nodes whose name matches the query, or that contain such children. */
export function treeMatchesQuery(node: WorkspaceTreeNode, query: string): boolean {
  const lower = query.toLowerCase();
  if (node.name.toLowerCase().includes(lower)) return true;
  return node.children.some((child) => treeMatchesQuery(child, lower));
}

export function filterWorkspaceTree(
  nodes: WorkspaceTreeNode[],
  query: string,
): WorkspaceTreeNode[] {
  if (!query.trim()) return nodes;
  return nodes.filter((node) => treeMatchesQuery(node, query.trim()));
}

/** Badge text + palette class for a workspace file name. */
export function badgeFor(name: string): { text: string; className: string } {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ipynb")) return { text: "nb", className: "lang-notebook" };
  if (lower.endsWith(".md") || lower.endsWith(".markdown"))
    return { text: "md", className: "lang-markdown" };
  if (lower.endsWith(".tex")) return { text: "tex", className: "lang-tex" };
  if (lower.endsWith(".pdf")) return { text: "pdf", className: "lang-pdf" };
  if (lower.endsWith(".json")) return { text: "js", className: "lang-json" };
  if (lower.endsWith(".py")) return { text: "py", className: "lang-python" };
  if (lower.endsWith(".csv")) return { text: "csv", className: "lang-config" };
  if (lower.endsWith(".png")) return { text: "png", className: "lang-other" };
  if (lower.endsWith(".svg")) return { text: "svg", className: "lang-other" };
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1, dot + 3) : "··";
  return { text: ext, className: "lang-other" };
}
