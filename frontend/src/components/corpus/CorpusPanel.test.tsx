/**
 * CorpusPanel tests: file tree rendering and selection, fragment list,
 * live research tabs (stage 4), changes dialog with confirmed re-index
 * (scenario D).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangesReport, FileContent, FileDetail, JobInfo, ProjectInfo } from "../../api/types";
import { useProjectStore } from "../../state/projectStore";
import { mockFetch, mockResponse } from "../../testUtils";
import { CorpusPanel } from "./CorpusPanel";

const PROJECT: ProjectInfo = {
  id: "p1",
  name: "Sample",
  created_at: "",
  updated_at: "",
  roots: ["/src_tree"],
  split_options: {
    max_file_size_bytes: 1000000,
    max_fragment_lines: 200,
    fallback_chunk_lines: 80,
    fallback_overlap_lines: 10,
    include_hidden: false,
    extra_include_patterns: [],
    extra_exclude_patterns: [],
    allow_symlinks_outside_root: false,
  },
  stats: { files_indexed: 2, files_error: 0, fragments: 3, running_job_id: null },
};

const FILE_A = {
  id: "fa",
  root: "/src_tree",
  rel_path: "src/a.py",
  size: 100,
  mtime: 0,
  language: "python",
  status: "indexed" as const,
  skip_reason: null,
  detail: null,
  indexed_at: null,
  fragment_count: 2,
};
const FILE_B = { ...FILE_A, id: "fb", rel_path: "b.py", fragment_count: 1 };

const DETAIL_A: FileDetail = {
  file: FILE_A,
  fragments: [
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
  ],
};

const CONTENT_A: FileContent = {
  file_id: "fa",
  rel_path: "src/a.py",
  language: "python",
  content: "class Cls:\n    def m(self): ...\n",
  total_lines: 2,
};

const CHANGES: ChangesReport = {
  new: [{ root: "/src_tree", rel_path: "c.py", size: 5, reason: "new" }],
  modified: [{ root: "/src_tree", rel_path: "b.py", size: 9, reason: "content" }],
  deleted: ["old.py"],
  unchanged_count: 1,
  skipped: [{ path: "/src_tree/.env", reason: "secret-file", detail: "excluded" }],
  root_errors: [],
  warnings: [],
};

const JOB_QUEUED: JobInfo = {
  id: "job1",
  kind: "index",
  state: "queued",
  progress_done: 0,
  progress_total: 0,
  message: null,
  error: null,
  warnings: [],
  created_at: "",
  started_at: null,
  finished_at: null,
};

function baseRoutes() {
  return {
    "/api/projects/p1/files/fa/content": CONTENT_A,
    "/api/projects/p1/files/fa": DETAIL_A,
    "/api/projects/p1/changes": CHANGES,
    "POST /api/projects/p1/index": mockResponse(202, JOB_QUEUED),
  };
}

function resetStore(overrides: Partial<ReturnType<typeof useProjectStore.getState>> = {}) {
  useProjectStore.setState({
    projects: [],
    current: PROJECT,
    files: [FILE_A, FILE_B],
    selectedFileId: null,
    fileDetail: null,
    fileContent: null,
    activeFragmentId: null,
    locatedFragments: null,
    locatedNote: null,
    searchQuery: "",
    searchResults: null,
    changes: null,
    changesLoading: false,
    activeJob: null,
    loading: false,
    error: null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
});

describe("CorpusPanel", () => {
  it("renders the file tree and selects a file on click", async () => {
    const { fetchMock } = mockFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchMock);
    resetStore();

    render(<CorpusPanel />);
    expect(screen.getByText("a.py")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();

    fireEvent.click(screen.getByText("a.py"));
    await waitFor(() => {
      expect(useProjectStore.getState().selectedFileId).toBe("fa");
    });
    // Fragments of the selected file appear in the list (rows show `name`).
    expect(await screen.findByText("Cls")).toBeTruthy();
    expect(screen.getByText("m")).toBeTruthy();
  });

  it("activates a fragment when clicked", async () => {
    const { fetchMock } = mockFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ selectedFileId: "fa", fileDetail: DETAIL_A, fileContent: CONTENT_A });

    render(<CorpusPanel />);
    fireEvent.click(screen.getByText("m"));
    await waitFor(() => {
      expect(useProjectStore.getState().activeFragmentId).toBe("fragA2");
    });
    // The selected-fragment card shows traceability data.
    expect(screen.getByText("Cls.m")).toBeTruthy();
    expect(screen.getByText("tree-sitter-python")).toBeTruthy();
  });

  it("all four research tabs are live (stage 4) and switch the pane", () => {
    const { fetchMock } = mockFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchMock);
    resetStore();

    render(<CorpusPanel />);
    for (const label of ["FRAGMENTS", "NEIGHBORS", "RELATIONS", "CLUSTERS"]) {
      const tab = screen.getByRole("tab", { name: new RegExp(label) });
      expect((tab as HTMLButtonElement).disabled).toBe(false);
    }
    expect(
      screen.getByRole("tab", { name: /FRAGMENTS/ }).getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: /NEIGHBORS/ }));
    expect(screen.getByLabelText("Семантические соседи")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /RELATIONS/ }));
    expect(screen.getByLabelText("Структурные связи")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /CLUSTERS/ }));
    expect(screen.getByLabelText("Кластеры и группы")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /FRAGMENTS/ }));
    expect(
      screen.getByRole("tab", { name: /FRAGMENTS/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("changes dialog lists diffs and starts indexing on confirm", async () => {
    const { fetchMock, calls } = mockFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ changes: CHANGES });

    render(<CorpusPanel />);
    expect(screen.getByText("Изменения корпуса")).toBeTruthy();
    expect(screen.getByText("c.py")).toBeTruthy();
    expect(screen.getByText("old.py")).toBeTruthy();
    expect(screen.getByText(/b\.py \(content\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Применить и переиндексировать" }));
    await waitFor(() => {
      expect(useProjectStore.getState().activeJob?.id).toBe("job1");
    });
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/index"))).toBe(true);
    // Dialog closed after starting the job.
    expect(useProjectStore.getState().changes).toBeNull();
  });

  it("shows an indexing hint for an empty project", () => {
    const { fetchMock } = mockFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ files: [] });

    render(<CorpusPanel />);
    expect(screen.getByText(/Проект пустой/)).toBeTruthy();
  });
});

describe("CorpusPanel staleness button", () => {
  const STALE = {
    dirty: true,
    new_count: 2,
    modified_count: 1,
    deleted_count: 3,
    unchanged_count: 0,
    root_errors: [],
  };

  it("lights up with a count badge when the corpus is stale", () => {
    const { fetchMock } = mockFetch({ ...baseRoutes(), "/staleness": STALE });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ staleness: STALE });

    render(<CorpusPanel />);
    const button = screen.getByRole("button", {
      name: "Изменения: требуется переиндексация",
    });
    expect(button.className).toContain("btn--alert");
    // Badge shows the total, not color alone (6 = 2 new + 1 mod + 3 del).
    expect(button.textContent).toContain("6");
  });

  it("stays neutral when the index is fresh", () => {
    const CLEAN = { ...STALE, dirty: false, new_count: 0, modified_count: 0, deleted_count: 0 };
    const { fetchMock } = mockFetch({ ...baseRoutes(), "/staleness": CLEAN });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ staleness: CLEAN });

    render(<CorpusPanel />);
    const button = screen.getByRole("button", { name: "Изменения" });
    expect(button.className).not.toContain("btn--alert");
    expect(button.textContent).not.toMatch(/\d/);
  });
});
