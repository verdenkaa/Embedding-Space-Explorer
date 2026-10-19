/**
 * WorkspaceTree component tests: rendering of dirs/files, expansion toggle,
 * selection callbacks and the empty states.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceEntry } from "../../api/types";
import { WorkspaceTree } from "./WorkspaceTree";

function entry(path: string, kind: "dir" | "file" = "file"): WorkspaceEntry {
  return { path, name: path.split("/").pop() ?? path, kind, size: 42, mtime: 1 };
}

const ENTRIES: WorkspaceEntry[] = [
  entry("notebooks", "dir"),
  entry("notebooks/geometry.ipynb"),
  entry("notes", "dir"),
  entry("notes/hypotheses.md"),
];

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof WorkspaceTree>[0]> = {}) {
  const onSelectFile = vi.fn();
  const onSelectDir = vi.fn();
  render(
    <WorkspaceTree
      entries={ENTRIES}
      selectedPath={null}
      query=""
      onSelectFile={onSelectFile}
      onSelectDir={onSelectDir}
      {...props}
    />,
  );
  return { onSelectFile, onSelectDir };
}

describe("WorkspaceTree", () => {
  it("renders directories and files", () => {
    setup();
    expect(screen.getByText("notebooks")).toBeTruthy();
    expect(screen.getByText("geometry.ipynb")).toBeTruthy();
    expect(screen.getByText("hypotheses.md")).toBeTruthy();
  });

  it("selects a file on click", () => {
    const { onSelectFile } = setup();
    fireEvent.click(screen.getByText("geometry.ipynb"));
    expect(onSelectFile).toHaveBeenCalledWith("notebooks/geometry.ipynb");
  });

  it("toggles a directory and reports dir selection", () => {
    const { onSelectDir } = setup();
    fireEvent.click(screen.getByText("notebooks"));
    expect(onSelectDir).toHaveBeenCalledWith("notebooks");
    // collapsed: the child is hidden
    expect(screen.queryByText("geometry.ipynb")).toBeNull();
    fireEvent.click(screen.getByText("notebooks"));
    expect(screen.getByText("geometry.ipynb")).toBeTruthy();
  });

  it("marks the selected path", () => {
    setup({ selectedPath: "notes/hypotheses.md" });
    const row = screen.getByText("hypotheses.md").closest(".tree-row");
    expect(row?.className).toContain("tree-row--selected");
  });

  it("filters by query keeping matching branches", () => {
    setup({ query: "hypo" });
    expect(screen.queryByText("geometry.ipynb")).toBeNull();
    expect(screen.getByText("hypotheses.md")).toBeTruthy();
  });

  it("shows the empty-workspace hint", () => {
    setup({ entries: [] });
    expect(screen.getByText(/Рабочее пространство пусто/)).toBeTruthy();
  });

  it("shows the no-match hint", () => {
    setup({ query: "zzz" });
    expect(screen.getByText(/Ничего не найдено/)).toBeTruthy();
  });

  it("shows document badges (nb for notebooks, md for notes)", () => {
    setup();
    expect(screen.getByText("nb")).toBeTruthy();
    expect(screen.getByText("md")).toBeTruthy();
  });
});
