/**
 * Space-view palette — the single source of truth for data colors drawn on
 * canvas / WebGL (which cannot read CSS variables at draw time).
 *
 * Every hex here MIRRORS a design token in theme/tokens.css:
 *   --color-plot, --color-grid-line, --color-grid-line-3d, --color-axis-*,
 *   --color-text-*, --color-fragment-*, --color-file-*, --color-accent*,
 *   --color-focus.
 * A unit test (palette.test.ts) parses tokens.css and fails if a value drifts,
 * so the DOM (CSS) and the scenes (this module) always agree — one color per
 * semantic category, no independent hardcoded copies.
 *
 * Data colors are the project's original saturated scheme (teal / blue /
 * green / gray for fragment kinds): they stay readable as small points on the
 * dark plot background. The ORANGE-AMBER (#e8b45a) is RESERVED for selection
 * markers (rings, selected-point glow, list markers) and deliberately appears
 * in NO point palette — a selected object must never be confusable with a
 * category color.
 */

export const COLORS = {
  /** Scene / plot background (matches --color-plot). */
  bg: "#202124",
  /** 2D canvas grid lines: pixel-aligned, low contrast is enough
   *  (matches --color-grid-line). */
  grid: "#303237",
  /** 3D floor-grid lines: oblique 1px WebGL lines lose ~half of their
   *  contrast to antialiasing, so the scene needs a stronger value than the
   *  2D canvas (matches --color-grid-line-3d). */
  grid3d: "#45474d",
  /** Plot frame / tick marks (matches --color-border-strong). */
  frame: "#45474d",
  /** Secondary canvas text (matches --color-text-dim). */
  textDim: "#a4a7ad",
  /** Muted canvas text: tick numbers, captions (matches --color-text-faint). */
  textFaint: "#777b83",
  /** Primary accent (matches --color-accent). */
  accent: "#3574f0",
  /** Neutral fallback for unknown categories (matches --color-fragment-other). */
  gray: "#8fa0ae",
  /** Faded context points outside an active slice layer. */
  dim: "#39424b",
  /** Multi-selection glow/ring — RESERVED: no point palette may use it
   *  (matches --color-accent-amber). */
  selected: "#e8b45a",
  /** Active-fragment ring/crosshair — same reserved selection color, told
   *  apart from the multi-selection by SHAPE (ring + crosshair). */
  active: "#e8b45a",
  /** Hover ring (transient, shape-only marker). */
  hover: "#ffffff",
} as const;

/**
 * Principal-axis line colors of the 3D scene (X, Y, Z — matches
 * --color-axis-x/y/z). Teal / blue / violet: mutually distinct and distinct
 * from the reserved selection orange.
 */
export const AXIS_COLORS: readonly [string, string, string] = [
  "#45d6c5",
  "#63a9ff",
  "#b48fd8",
];

/* ------------------------------------------------------------------ */
/* Fragment-type colors (MTH / FN / CLS + document / fallback)          */
/* ------------------------------------------------------------------ */

/** Fragment kind → point/badge color (mirrors --color-fragment-*). */
const KIND_COLOR: Record<string, string> = {
  function: "#45d6c5", // FN  — teal, --color-fragment-fn
  method: "#45d6c5", // MTH — teal, same family as FN (badge text disambiguates)
  class: "#63a9ff", // CLS — blue, --color-fragment-cls
  interface: "#63a9ff",
  type_alias: "#63a9ff",
  enum: "#63a9ff",
  object: "#63a9ff",
  section: "#7bd88f", // document section — green, --color-fragment-section
};

/** Kind → point color (same grouping as the corpus/inspector badges). */
export function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? COLORS.gray;
}

/* ------------------------------------------------------------------ */
/* File-type colors (tree badge = point = legend, one color each)       */
/* ------------------------------------------------------------------ */

/** Canonical file-type colors (mirror --color-file-*). Saturated and
 *  mutually distinct; the orange/amber band is left free for selection. */
export const FILE_COLORS = {
  python: "#58a6ff",
  javascript: "#b8d55a",
  typescript: "#39c5cf",
  markdown: "#c586f0",
  json: "#ef7fae",
  config: "#5fd38a",
  other: "#8fa0ae",
} as const;

export type FileType = keyof typeof FILE_COLORS;

/** Backend `language` id → file type. */
const LANGUAGE_TYPE: Record<string, FileType> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  tsx: "typescript",
  markdown: "markdown",
  json: "json",
  yaml: "config",
  toml: "config",
  ini: "config",
};

/** File extension (no dot, lowercase) → file type. */
const EXT_TYPE: Record<string, FileType> = {
  py: "python",
  pyi: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "json",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  cfg: "config",
  conf: "config",
  env: "config",
};

/** Human label of a file type (legend text when coloring by file). */
export const FILE_TYPE_LABEL: Record<FileType, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  markdown: "Markdown",
  json: "JSON",
  config: "config",
  other: "прочее",
};

/** Language id → file-type color (for tree badges, which know the language). */
export function languageColor(language: string | null | undefined): string {
  if (!language) return FILE_COLORS.other;
  return FILE_COLORS[LANGUAGE_TYPE[language] ?? "other"];
}

/** Language id → canonical file type (legend keys, badges). */
export function languageFileType(language: string | null | undefined): FileType {
  if (!language) return "other";
  return LANGUAGE_TYPE[language] ?? "other";
}

/** Extension of a relative path (lowercase, no dot; "" when none). */
export function extOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Relative path → file-type color (for points colored by file). */
export function pathColor(relPath: string): string {
  return FILE_COLORS[EXT_TYPE[extOf(relPath)] ?? "other"];
}

/** Relative path → canonical file type (legend keys). */
export function pathFileType(relPath: string): FileType {
  return EXT_TYPE[extOf(relPath)] ?? "other";
}

/* ------------------------------------------------------------------ */
/* WebGL helpers                                                        */
/* ------------------------------------------------------------------ */

/** sRGB channel (0..1) → linear-light channel (three.js works in linear). */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * hex → LINEAR normalized RGB triple for WebGL color buffers. Vertex colors
 * are consumed by three.js as-is (no color-space conversion), so raw sRGB
 * values would render washed-out pastel; converting here makes a point on
 * screen match its hex in the legend and in the 2D canvas exactly.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [
    srgbToLinear(((v >> 16) & 255) / 255),
    srgbToLinear(((v >> 8) & 255) / 255),
    srgbToLinear((v & 255) / 255),
  ];
}

/** Legend entries present in a cloud, in a stable order (label = the text key,
 *  so color is never the only identifier). */
export interface LegendEntry {
  kind: string;
  color: string;
  count: number;
}

/**
 * Deterministic cluster palette (golden-angle hues): the same label always
 * gets the same color within a session; noise (-1) is the neutral gray and
 * the legend ALWAYS carries text labels («кластер N» / «шум») — color is
 * never the only identifier. The orange/amber band (10°..70°) is SKIPPED:
 * it is reserved for the selection markers.
 */
export function clusterColor(label: number): string {
  if (label < 0) return COLORS.gray;
  let hue = (label * 137.508) % 360;
  if (hue >= 10 && hue <= 70) hue = (hue + 60) % 360;
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

/** Legend over arbitrary color keys (kinds, file types OR cluster names). */
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
