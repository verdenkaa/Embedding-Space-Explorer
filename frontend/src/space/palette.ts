/**
 * Space-view palette. Colors mirror the design tokens (theme/tokens.css) and
 * the kind→color grouping already used by the corpus/Monaco badges
 * (monaco/helpers.ts kindColorClass): teal = functions/methods, blue =
 * types/classes, amber = document sections, gray = everything else.
 * Canvas/WebGL cannot read CSS variables, so the hex values are duplicated
 * here — keep them in sync with tokens.css (single visual language).
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
 * text, so color is never the only identifier). */
export interface LegendEntry {
  kind: string;
  color: string;
  count: number;
}

/**
 * Deterministic cluster palette (golden-angle hues): the same label always
 * gets the same color within a session; noise (-1) is the neutral gray and
 * the legend ALWAYS carries text labels («кластер N» / «шум») — color is
 * never the only identifier.
 */
export function clusterColor(label: number): string {
  if (label < 0) return COLORS.gray;
  const hue = (label * 137.508) % 360;
  return hslToHex(hue, 0.62, 0.58);
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Legend over arbitrary color keys (kinds OR cluster names), first-seen order. */
export function buildLegendFrom(
  keys: Iterable<string>,
  colorOf: (key: string) => string,
): LegendEntry[] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({
    kind: key,
    color: colorOf(key),
    count,
  }));
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
