/**
 * Pure Monaco-related helpers. Kept free of monaco-editor imports so they
 * are unit-testable in jsdom (setup.ts does the side-effectful wiring).
 */

import type { FragmentMeta } from "../api/types";

export const ESE_THEME = "ese-dark";

export interface LineRange {
  startLine: number;
  endLine: number;
}

/** Map backend language ids to Monaco language ids. */
export function monacoLanguageFor(language: string | null): string {
  switch (language) {
    case "python":
      return "python";
    case "javascript":
      return "javascript";
    case "typescript":
      return "typescript";
    case "tsx":
      return "typescript";
    case "markdown":
      return "markdown";
    default:
      return "plaintext";
  }
}

export interface DecorationSpec {
  range: LineRange;
  className: string;
  glyphClassName?: string;
}

/**
 * Build decorations for a file: the active fragment gets a teal highlight,
 * every other fragment gets a subtle left ruler. Order: others first, then
 * the active one (later decorations render on top).
 */
export function computeDecorations(
  fragments: FragmentMeta[],
  activeFragmentId: string | null,
): DecorationSpec[] {
  const others: DecorationSpec[] = [];
  let active: DecorationSpec | null = null;
  for (const f of fragments) {
    if (f.id === activeFragmentId) {
      active = {
        range: { startLine: f.start_line, endLine: f.end_line },
        className: "ese-fragment-active",
        glyphClassName: "ese-fragment-active-glyph",
      };
    } else {
      others.push({
        range: { startLine: f.start_line, endLine: f.end_line },
        className: "ese-fragment-marker",
      });
    }
  }
  return active ? [...others, active] : others;
}

/** Kind → short badge label (non-color-only identification). */
export function kindBadge(kind: string): string {
  switch (kind) {
    case "function":
      return "fn";
    case "method":
      return "mth";
    case "class":
      return "cls";
    case "interface":
      return "if";
    case "type_alias":
      return "ta";
    case "enum":
      return "en";
    case "object":
      return "obj";
    case "section":
      return "§";
    case "chunk":
      return "ch";
    default:
      return kind.slice(0, 3);
  }
}

/** Kind → color group class (teal / blue / amber / gray). */
export function kindColorClass(kind: string): string {
  switch (kind) {
    case "function":
    case "method":
      return "kind--teal";
    case "class":
    case "interface":
    case "type_alias":
    case "enum":
    case "object":
      return "kind--blue";
    case "section":
      return "kind--amber";
    default:
      return "kind--gray";
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
