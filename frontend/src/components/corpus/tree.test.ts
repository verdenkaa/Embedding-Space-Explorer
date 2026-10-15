import { describe, expect, it } from "vitest";

import type { FileSummary } from "../../api/types";
import { buildFileTree, treeMatchesQuery } from "./tree";

function file(relPath: string, id = relPath): FileSummary {
  return {
    id,
    root: "/p",
    rel_path: relPath,
    size: 10,
    mtime: 0,
    language: null,
    status: "indexed",
    skip_reason: null,
    detail: null,
    indexed_at: null,
    fragment_count: 0,
  };
}

describe("buildFileTree", () => {
  it("nests files into directories", () => {
    const tree = buildFileTree([
      file("src/app/main.py"),
      file("src/util.py"),
      file("README.md"),
    ]);
    expect(tree).toHaveLength(2); // README.md + src (dirs first after sort)
    expect(tree[0].name).toBe("src");
    expect(tree[0].isDir).toBe(true);
    expect(tree[1].name).toBe("README.md");

    const src = tree[0];
    expect(src.children.map((c) => c.name)).toEqual(["app", "util.py"]);
    expect(src.children[0].children[0].file?.rel_path).toBe("src/app/main.py");
  });

  it("sorts directories before files", () => {
    const tree = buildFileTree([file("z/b.py"), file("a.py"), file("m/c.py")]);
    expect(tree.map((n) => n.name)).toEqual(["m", "z", "a.py"]);
  });

  it("filters by query across nesting", () => {
    const tree = buildFileTree([file("src/app.py"), file("docs/guide.md")]);
    const byName = Object.fromEntries(tree.map((n) => [n.name, n]));
    expect(treeMatchesQuery(byName["src"], "app.py")).toBe(true);
    expect(treeMatchesQuery(byName["src"], "guide")).toBe(false);
    expect(treeMatchesQuery(byName["docs"], "guide")).toBe(true);
  });
});
