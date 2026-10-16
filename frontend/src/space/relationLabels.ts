/**
 * Relation kinds: text badges + colors. Structural relations must be
 * visually distinct from semantic proximity (TZ §7.2, stage-4 acceptance):
 * every kind carries a TEXT badge (never color-only) and its own glyph.
 */

import { COLORS } from "./palette";

export const RELATION_COLORS: Record<string, string> = {
  imports: COLORS.blue,
  belongs_to: COLORS.gray,
  calls: COLORS.teal,
  tested_by: "#7bd88f",
  tests: "#7bd88f",
  documents: COLORS.amber,
  describes: COLORS.amber,
  references: "#b48fd8",
};

const FALLBACK_COLOR = "#b48fd8";

export function relationColor(kind: string): string {
  return RELATION_COLORS[kind] ?? FALLBACK_COLOR;
}

const RELATION_BADGES: Record<string, string> = {
  imports: "imp",
  belongs_to: "part-of",
  calls: "call",
  tested_by: "tested",
  tests: "tests",
  documents: "doc",
  describes: "descr",
  references: "ref",
};

/** Short text badge of a relation kind (unknown kinds keep a trimmed name). */
export function relationBadge(kind: string): string {
  return RELATION_BADGES[kind] ?? kind.slice(0, 8);
}

const RELATION_GLYPHS: Record<string, string> = {
  imports: "→|",
  belongs_to: "⊂",
  calls: "ƒ→",
  tested_by: "✓←",
  tests: "✓→",
  documents: "¶→",
  describes: "¶",
  references: "⋯→",
};

export function relationGlyph(kind: string): string {
  return RELATION_GLYPHS[kind] ?? "→";
}

export const ORIGIN_LABELS: Record<string, string> = {
  extracted: "извлечено",
  imported: "импорт",
  manual: "вручную",
};

/** Cap on relation lines drawn in one scene (readability, TZ §7.2). */
export const RELATION_LINE_LIMIT = 300;
