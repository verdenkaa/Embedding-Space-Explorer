/**
 * SourceInspector tests. Monaco itself cannot run in jsdom — the Editor
 * component is mocked; we verify wiring: content, path header, locator chips
 * (reverse tracing) and fragment activation.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileContent, FileDetail, FragmentMeta } from "../../api/types";
import { useProjectStore } from "../../state/projectStore";

vi.mock("@monaco-editor/react", () => ({
  Editor: (props: { value?: string }) => (
    <div data-testid="monaco-editor">
      <pre>{props.value}</pre>
    </div>
  ),
  loader: { config: vi.fn() },
}));

import { SourceInspector } from "./SourceInspector";

const FRAGMENTS: FragmentMeta[] = [
  {
    id: "fragA1",
    file_id: "fa",
    kind: "class",
    name: "Cls",
    symbol_path: "Cls",
    parent_symbol_path: null,
    start_line: 1,
    end_line: 10,
    method: "tree-sitter-python",
    language: "python",
    ordinal: 0,
  },
  {
    id: "fragA2",
    file_id: "fa",
    kind: "method",
    name: "m",
    symbol_path: "Cls.m",
    parent_symbol_path: "Cls",
    start_line: 5,
    end_line: 6,
    method: "tree-sitter-python",
    language: "python",
    ordinal: 0,
  },
];

const DETAIL: FileDetail = {
  file: {
    id: "fa",
    root: "/src_tree",
    rel_path: "a.py",
    size: 10,
    mtime: 0,
    language: "python",
    status: "indexed",
    skip_reason: null,
    detail: null,
    indexed_at: null,
    fragment_count: 2,
  },
  fragments: FRAGMENTS,
};

const CONTENT: FileContent = {
  file_id: "fa",
  rel_path: "a.py",
  language: "python",
  content: "class Cls:\n    def m(self): ...\n",
  total_lines: 2,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({
    current: null,
    files: null,
    selectedFileId: "fa",
    fileDetail: DETAIL,
    fileContent: CONTENT,
    activeFragmentId: null,
    locatedFragments: null,
    locatedNote: null,
    error: null,
    loading: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("SourceInspector", () => {
  it("shows an empty hint without a file", () => {
    useProjectStore.setState({ fileContent: null, fileDetail: null });
    render(<SourceInspector />);
    expect(screen.getByText(/Выберите файл в дереве слева/)).toBeTruthy();
  });

  it("renders file content and header", () => {
    render(<SourceInspector />);
    expect(screen.getByTestId("monaco-editor").textContent).toContain("class Cls:");
    expect(screen.getByText("a.py")).toBeTruthy();
    expect(screen.getByText(/только просмотр/)).toBeTruthy();
  });

  it("locator chips show intersecting fragments and activate on click", async () => {
    useProjectStore.setState({
      locatedFragments: FRAGMENTS,
      locatedNote: "Выбор пересекает 2 фрагментов",
    });
    render(<SourceInspector />);

    expect(screen.getByText("Фрагменты в выделении:")).toBeTruthy();
    const chips = screen.getAllByRole("button");
    // Chip content: kind badge ("mth") + name ("m") + line range.
    const methodChip = chips.find((c) => c.textContent?.includes("mth"));
    expect(methodChip).toBeTruthy();

    fireEvent.click(methodChip!);
    await waitFor(() => {
      expect(useProjectStore.getState().activeFragmentId).toBe("fragA2");
    });
  });
});
