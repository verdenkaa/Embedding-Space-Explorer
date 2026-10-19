/**
 * Palette single-source-of-truth test.
 *
 * The DOM reads colors from CSS custom properties (theme/tokens.css); the
 * canvas/WebGL scenes read them from space/palette.ts (which cannot access CSS
 * variables at draw time). This test parses tokens.css and asserts the two
 * never drift — so a file/fragment/grid color changed in one place is
 * guaranteed to match the other (tree badge = point = legend = grid).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AXIS_COLORS,
  COLORS,
  FILE_COLORS,
  extOf,
  kindColor,
  languageColor,
  languageFileType,
  pathColor,
  pathFileType,
} from "./palette";

// Tests run from the frontend/ package root (npm script cwd), so a plain
// relative path is stable here.
const tokensCss = readFileSync("src/theme/tokens.css", "utf8");

/** Read a `--name: #rrggbb;` token from tokens.css. */
function token(name: string): string {
  const m = tokensCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found in tokens.css`);
  return m[1].toLowerCase();
}

describe("palette mirrors tokens.css (single source of truth)", () => {
  it("file-type colors match the --color-file-* tokens", () => {
    expect(FILE_COLORS.python).toBe(token("color-file-python"));
    expect(FILE_COLORS.javascript).toBe(token("color-file-javascript"));
    expect(FILE_COLORS.typescript).toBe(token("color-file-typescript"));
    expect(FILE_COLORS.markdown).toBe(token("color-file-markdown"));
    expect(FILE_COLORS.json).toBe(token("color-file-json"));
    expect(FILE_COLORS.config).toBe(token("color-file-config"));
    expect(FILE_COLORS.other).toBe(token("color-file-other"));
  });

  it("fragment-type colors match the --color-fragment-* tokens", () => {
    expect(kindColor("function")).toBe(token("color-fragment-fn"));
    expect(kindColor("method")).toBe(token("color-fragment-mth"));
    expect(kindColor("class")).toBe(token("color-fragment-cls"));
    expect(kindColor("section")).toBe(token("color-fragment-section"));
    expect(kindColor("chunk")).toBe(token("color-fragment-other"));
  });

  it("scene/grid colors match the surface & grid tokens", () => {
    expect(COLORS.bg).toBe(token("color-plot"));
    expect(COLORS.grid).toBe(token("color-grid-line"));
    expect(COLORS.grid3d).toBe(token("color-grid-line-3d"));
    expect(COLORS.textDim).toBe(token("color-text-dim"));
    expect(COLORS.textFaint).toBe(token("color-text-faint"));
    expect(COLORS.accent).toBe(token("color-accent"));
    expect(COLORS.frame).toBe(token("color-border-strong"));
  });

  it("principal-axis colors match the --color-axis-* tokens", () => {
    expect(AXIS_COLORS[0]).toBe(token("color-axis-x"));
    expect(AXIS_COLORS[1]).toBe(token("color-axis-y"));
    expect(AXIS_COLORS[2]).toBe(token("color-axis-z"));
  });
});

describe("file coloring resolves by language and by extension", () => {
  it("extOf reads the lowercase extension", () => {
    expect(extOf("src/app/component.TSX")).toBe("tsx");
    expect(extOf("README")).toBe("");
    expect(extOf("a/b/.env")).toBe(""); // dotfile → no extension
  });

  it("a language and its extension resolve to the SAME color", () => {
    expect(languageColor("python")).toBe(pathColor("pkg/mod.py"));
    expect(languageColor("typescript")).toBe(pathColor("web/app.tsx"));
    expect(languageColor("javascript")).toBe(pathColor("web/chart.js"));
    expect(languageColor("markdown")).toBe(pathColor("docs/guide.md"));
  });

  it("config/data extensions map to their file type", () => {
    expect(pathFileType("config.yaml")).toBe("config");
    expect(pathFileType("data.json")).toBe("json");
    expect(pathFileType("main.py")).toBe("python");
    expect(languageFileType("tsx")).toBe("typescript");
  });

  it("unknown extensions fall back to the neutral 'other' color", () => {
    expect(pathColor("archive.zip")).toBe(FILE_COLORS.other);
    expect(languageColor(null)).toBe(FILE_COLORS.other);
  });
});
