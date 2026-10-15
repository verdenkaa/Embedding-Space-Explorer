import { describe, expect, it } from "vitest";

import type { FragmentMeta } from "../api/types";
import { computeDecorations, kindBadge, kindColorClass, monacoLanguageFor } from "./helpers";

function meta(id: string, start: number, end: number): FragmentMeta {
  return {
    id,
    file_id: "f1",
    kind: "function",
    name: id,
    symbol_path: id,
    parent_symbol_path: null,
    start_line: start,
    end_line: end,
    method: "tree-sitter-python",
    language: "python",
    ordinal: 0,
  };
}

describe("monacoLanguageFor", () => {
  it("maps backend language ids", () => {
    expect(monacoLanguageFor("python")).toBe("python");
    expect(monacoLanguageFor("tsx")).toBe("typescript");
    expect(monacoLanguageFor("markdown")).toBe("markdown");
    expect(monacoLanguageFor(null)).toBe("plaintext");
    expect(monacoLanguageFor("unknown")).toBe("plaintext");
  });
});

describe("computeDecorations", () => {
  it("marks the active fragment last (on top) and others subtle", () => {
    const frags = [meta("a", 1, 5), meta("b", 10, 12), meta("c", 20, 30)];
    const specs = computeDecorations(frags, "b");
    expect(specs).toHaveLength(3);
    // Active one is last so it renders above the markers.
    const active = specs[specs.length - 1];
    expect(active.className).toBe("ese-fragment-active");
    expect(active.range).toEqual({ startLine: 10, endLine: 12 });
    expect(active.glyphClassName).toBeTruthy();
    expect(specs.slice(0, 2).every((s) => s.className === "ese-fragment-marker")).toBe(true);
  });

  it("returns only markers without an active fragment", () => {
    const specs = computeDecorations([meta("a", 1, 5)], null);
    expect(specs).toHaveLength(1);
    expect(specs[0].className).toBe("ese-fragment-marker");
  });
});

describe("kind presentation", () => {
  it("badges differ by kind and are not color-only", () => {
    expect(kindBadge("function")).toBe("fn");
    expect(kindBadge("method")).toBe("mth");
    expect(kindBadge("class")).toBe("cls");
    expect(kindBadge("section")).toBe("§");
    expect(kindBadge("chunk")).toBe("ch");
    expect(kindBadge("weird")).toBe("wei");
  });

  it("color classes group kinds", () => {
    expect(kindColorClass("method")).toBe("kind--teal");
    expect(kindColorClass("interface")).toBe("kind--blue");
    expect(kindColorClass("section")).toBe("kind--amber");
    expect(kindColorClass("chunk")).toBe("kind--gray");
  });
});
