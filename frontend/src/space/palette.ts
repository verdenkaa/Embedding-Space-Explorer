/**
 * Space-view palette. Colors mirror the design tokens (theme/tokens.css) and
 * the kind→color grouping already used by the corpus/Monaco badges
 * (monaco/helpers.ts kindColorClass): teal = functions/methods, blue =
 * types/classes, amber = document sections, gray = everything else.
 * Canvas/WebGL cannot read CSS variables, so the hex values are duplicated
 * here — keep them in sync with tokens.css (single visual language, TZ §4.1).
 */

export const COLORS = {
  bg: "#101316",
  grid: "rgba(69, 214, 197, 0.06)",
  axis: "#3a4650",
  textDim: "#8a97a3",
  textFaint: "#5c6873",
  teal: "#45d6c5",
  blue: "#63a9ff",
  amber: "#e8b45a",
  gray: "#8fa0ae",
  selected: "#e8b45a", // amber ring for multi-selection
  active: "#45d6c5", // teal ring for the active fragment
  hover: "#ffffff",
} as const;

const KIND_COLOR: Record<string, string> = {
  function: COLORS.teal,
  method: COLORS.teal,
  class: COLORS.blue,
  interface: COLORS.blue,
  type_alias: COLORS.blue,
  enum: COLORS.blue,
  object: COLORS.blue,
  section: COLORS.amber,
};

/** Kind → point color (same grouping as kindColorClass in the corpus UI). */
export function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? COLORS.gray;
}

/** hex → normalized RGB triple for WebGL color buffers. */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Legend entries present in a cloud, in a stable order (label = corpus badge
 * text, so color is never the only identifier — TZ §4.1). */
export interface LegendEntry {
  kind: string;
  color: string;
  count: number;
}

export function buildLegend(kinds: Iterable<string>): LegendEntry[] {
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const order = [
    "function",
    "method",
    "class",
    "interface",
    "type_alias",
    "enum",
    "object",
    "section",
    "chunk",
  ];
  const known = order.filter((k) => counts.has(k));
  const rest = [...counts.keys()].filter((k) => !order.includes(k)).sort();
  return [...known, ...rest].map((kind) => ({
    kind,
    color: kindColor(kind),
    count: counts.get(kind) ?? 0,
  }));
}
