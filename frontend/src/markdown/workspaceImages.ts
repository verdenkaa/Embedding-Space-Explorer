/**
 * Relative image sources inside workspace documents.
 *
 * Notes reference files of the SAME project workspace (typically plots saved
 * by notebook kernels into results/). Browsers would resolve a relative src
 * against the frontend origin (404), so relative sources are rewritten to the
 * backend raw endpoint: /api/projects/{id}/workspace/raw?path=<workspace-rel>.
 *
 * Resolution rule (matches Pandoc's document-relative resources, TZ §7.7):
 * the src is resolved against the DIRECTORY of the document; ".." segments
 * may climb but never above the workspace root (such sources are left alone —
 * the backend would reject them anyway). Absolute URLs (http/https/data/blob)
 * and root-relative "/…" are never touched.
 */

import { workspaceApi } from "../api/client";

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Strip query/hash, remember them to re-append after resolution. */
function splitUrl(src: string): { path: string; suffix: string } {
  const cut = src.search(/[?#]/);
  if (cut < 0) return { path: src, suffix: "" };
  return { path: src.slice(0, cut), suffix: src.slice(cut) };
}

/**
 * Resolve a relative src against the document's workspace path.
 * Returns the workspace-relative path, or null when the src must stay as is
 * (absolute URL, root-relative, empty, or escaping the workspace root).
 */
export function resolveWorkspaceSrc(docPath: string, src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;
  if (ABSOLUTE_URL.test(trimmed)) return null;
  if (trimmed.startsWith("/")) return null; // root-relative URL — not ours to rewrite

  const { path, suffix } = splitUrl(trimmed);
  const base = docPath.replace(/\\/g, "/").split("/").slice(0, -1);
  const out: string[] = [...base];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null; // escapes the workspace root — leave alone
      out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length === 0) return null;
  return out.join("/") + suffix;
}

/** Backend URL that serves a workspace file as a binary resource. */
export function rawSrcUrl(projectId: string, workspacePath: string): string {
  return workspaceApi.rawUrl(projectId, workspacePath);
}

/** True when an <img> src points at a same-origin API URL we produced. */
export function isRawUrl(src: string): boolean {
  return src.startsWith("/api/") && src.includes("/workspace/raw?path=");
}

/**
 * Rewrite relative <img src> in rendered (already sanitized) HTML so the
 * preview shows workspace files. Parses with DOMParser and re-serializes;
 * only src attributes of images are changed.
 */
export function rewriteHtmlImages(html: string, projectId: string, docPath: string): string {
  if (!html.includes("<img")) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  let touched = false;
  for (const img of Array.from(parsed.querySelectorAll("img"))) {
    const src = img.getAttribute("src");
    if (src === null) continue;
    const resolved = resolveWorkspaceSrc(docPath, src);
    if (resolved === null) continue;
    img.setAttribute("src", rawSrcUrl(projectId, resolved));
    img.setAttribute("data-ese-src", src); // original source stays inspectable
    touched = true;
  }
  return touched ? parsed.body.innerHTML : html;
}

/**
 * Idempotently rewrite relative <img src> inside a LIVE DOM subtree
 * (the Crepe WYSIWYG editor). Marks rewritten images with data-ese-src so
 * re-renders are detected and the document's own attrs are never touched —
 * ProseMirror serializes from node attrs, not from the DOM we adjust here.
 */
export function rewriteDomImages(root: HTMLElement, projectId: string, docPath: string): void {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const original = img.getAttribute("data-ese-src");
    const current = img.getAttribute("src");
    if (original !== null) {
      // Already rewritten once: re-apply only if the editor reset the src.
      const expected = rawSrcUrl(projectId, resolveWorkspaceSrc(docPath, original) ?? original);
      if (current !== expected) img.setAttribute("src", expected);
      continue;
    }
    if (current === null) continue;
    const resolved = resolveWorkspaceSrc(docPath, current);
    if (resolved === null) continue;
    img.setAttribute("data-ese-src", current);
    img.setAttribute("src", rawSrcUrl(projectId, resolved));
  }
}
