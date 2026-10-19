/**
 * researchTree pure-logic tests: tree building from the flat workspace
 * listing, sorting (dirs first), query filtering and file badges.
 */

import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../../api/types";
import {
  badgeFor,
  buildWorkspaceTree,
  filterWorkspaceTree,
} from "./researchTree";

function entry(path: string, kind: "dir" | "file" = "file"): WorkspaceEntry {
  return { path, name: path.split("/").pop() ?? path, kind, size: 10, mtime: 1 };
}

const ENTRIES: WorkspaceEntry[] = [
  entry("notebooks", "dir"),
  entry("notebooks/geometry.ipynb"),
  entry("notes", "dir"),
  entry("notes/hypotheses.md"),
  entry("notes/deep", "dir"),
  entry("notes/deep/observations.md"),
  entry("results", "dir"),
];

describe("buildWorkspaceTree", () => {
  it("nests files under directories", () => {
    const tree = buildWorkspaceTree(ENTRIES);
    expect(tree.map((n) => n.name)).toEqual(["notebooks", "notes", "results"]);
    const notes = tree.find((n) => n.name === "notes");
    expect(notes?.children.map((c) => c.name)).toEqual(["deep", "hypotheses.md"]);
    const deep = notes?.children.find((c) => c.name === "deep");
    expect(deep?.children[0]?.path).toBe("notes/deep/observations.md");
  });

  it("creates implicit directories for orphan file paths", () => {
    const tree = buildWorkspaceTree([entry("exports/report.pdf")]);
    expect(tree[0].name).toBe("exports");
    expect(tree[0].isDir).toBe(true);
    expect(tree[0].children[0].name).toBe("report.pdf");
  });

  it("keeps the backend entry on file nodes", () => {
    const tree = buildWorkspaceTree(ENTRIES);
    const nb = tree[0].children[0];
    expect(nb.entry?.kind).toBe("file");
    expect(nb.entry?.size).toBe(10);
  });
});

describe("filterWorkspaceTree", () => {
  it("matches by substring case-insensitively, keeps parents", () => {
    const tree = buildWorkspaceTree(ENTRIES);
    const filtered = filterWorkspaceTree(tree, "OBSERV");
    // The whole matching branch is kept (same semantics as the corpus tree).
    expect(filtered.map((n) => n.name)).toEqual(["notes"]);
    expect(filtered[0].children.map((n) => n.name)).toEqual(["deep", "hypotheses.md"]);
  });

  it("returns everything for an empty query", () => {
    const tree = buildWorkspaceTree(ENTRIES);
    expect(filterWorkspaceTree(tree, "  ")).toBe(tree);
  });
});

describe("badgeFor", () => {
  it("maps known document kinds", () => {
    expect(badgeFor("analysis.ipynb")).toEqual({ text: "nb", className: "lang-notebook" });
    expect(badgeFor("note.MD")).toEqual({ text: "md", className: "lang-markdown" });
    expect(badgeFor("report.tex")).toEqual({ text: "tex", className: "lang-tex" });
    expect(badgeFor("report.pdf")).toEqual({ text: "pdf", className: "lang-pdf" });
    expect(badgeFor("calc.py")).toEqual({ text: "py", className: "lang-python" });
  });

  it("falls back to the first extension letters", () => {
    expect(badgeFor("archive.tar.gz")).toEqual({ text: "gz", className: "lang-other" });
    expect(badgeFor("LICENSE")).toEqual({ text: "··", className: "lang-other" });
  });
});
