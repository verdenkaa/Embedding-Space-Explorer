/**
 * Relation kinds: text badges + colors. Structural relations must be
 * visually distinct from semantic proximity:
 * every kind carries a TEXT badge (never color-only) and its own glyph.
 *
 * These are categorical line colors (their own palette, drawn from the same
 * muted family as the file/fragment tokens) — the single source for relation
 * colors; the RELATIONS section and the 3D relation lines both read them.
 */

export const RELATION_COLORS: Record<string, string> = {
  imports: "#58b6d8",
  belongs_to: "#8d9199",
  calls: "#6c9ef8",
  tested_by: "#81c995",
  tests: "#81c995",
  documents: "#e8c56d",
  describes: "#e8c56d",
  references: "#b39ddb",
};

const FALLBACK_COLOR = "#b39ddb";

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

/** Cap on relation lines drawn in one scene (readability). */
export const RELATION_LINE_LIMIT = 300;
