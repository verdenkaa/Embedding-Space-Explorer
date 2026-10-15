/**
 * projectStore logic tests with a routed fetch mock: open/create project,
 * file selection, fragment selection across files, reverse locate,
 * changes flow and job polling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChangesReport,
  FileContent,
  FileDetail,
  JobInfo,
  LocateResponse,
  ProjectInfo,
  ProjectSummary,
} from "../api/types";
import { useProjectStore } from "./projectStore";
import { mockFetch, mockReject, mockResponse } from "../testUtils";

const PROJECT: ProjectInfo = {
  id: "p1",
  name: "Sample",
  created_at: "2026-10-15T00:00:00+00:00",
  updated_at: "2026-10-15T00:00:00+00:00",
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

const PROJECTS: ProjectSummary[] = [
  { id: "p1", name: "Sample", updated_at: PROJECT.updated_at, roots: PROJECT.roots, error: null },
];

const FILE_A = {
  id: "fa",
  root: "/src_tree",
  rel_path: "a.py",
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
  rel_path: "a.py",
  language: "python",
  content: "class Cls:\n    pass\n",
  total_lines: 2,
};

const CHANGES: ChangesReport = {
  new: [{ root: "/src_tree", rel_path: "c.py", size: 5, reason: "new" }],
  modified: [],
  deleted: [],
  unchanged_count: 2,
  skipped: [{ path: "/src_tree/.env", reason: "secret-file", detail: "…" }],
  root_errors: [],
  warnings: [],
};

function job(state: JobInfo["state"], done = 0, total = 3): JobInfo {
  return {
    id: "job1",
    kind: "index",
    state,
    progress_done: done,
    progress_total: total,
    message: state === "done" ? "index complete" : "working",
    error: null,
    warnings: [],
    created_at: "",
    started_at: null,
    finished_at: null,
  };
}

function resetStore() {
  useProjectStore.setState({
    projects: null,
    current: null,
    files: null,
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
    staleness: null,
    activeJob: null,
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetStore();
});

describe("projectStore", () => {
  it("loads projects and opens one (files refreshed)", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects": PROJECTS,
      "/api/projects/p1": PROJECT,
      "/api/projects/p1/files": [FILE_A, FILE_B],
    });
    vi.stubGlobal("fetch", fetchMock);

    await useProjectStore.getState().loadProjects();
    expect(useProjectStore.getState().projects).toEqual(PROJECTS);

    await useProjectStore.getState().openProject("p1");
    const state = useProjectStore.getState();
    expect(state.current?.name).toBe("Sample");
    expect(state.files).toHaveLength(2);
    expect(state.selectedFileId).toBeNull();
  });

  it("creates a project and opens it", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /api/projects": mockResponse(201, PROJECT),
      "/api/projects/p1/files": [],
      "/api/projects/p1": PROJECT,
      "/api/projects": PROJECTS,
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await useProjectStore
      .getState()
      .createProject({ name: "Sample", roots: ["/src_tree"], split_options: null });
    expect(created?.id).toBe("p1");
    const postCall = calls.find((c) => c.method === "POST");
    expect(postCall?.body).toEqual({ name: "Sample", roots: ["/src_tree"], split_options: null });
    expect(useProjectStore.getState().current?.id).toBe("p1");
  });

  it("selectFile loads detail and content, clears selection", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/files/fa/content": CONTENT_A,
      "/api/projects/p1/files/fa": DETAIL_A,
    });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({ current: PROJECT, activeFragmentId: "stale" });

    await useProjectStore.getState().selectFile("fa");
    const state = useProjectStore.getState();
    expect(state.fileDetail?.fragments).toHaveLength(2);
    expect(state.fileContent?.content).toContain("class Cls");
    expect(state.activeFragmentId).toBeNull();
  });

  it("selectFragment switches file when needed", async () => {
    const { fetchMock } = mockFetch({
      "/content": CONTENT_A,
      "/api/projects/p1/files/fa": DETAIL_A,
    });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({ current: PROJECT, selectedFileId: "fb" });

    await useProjectStore.getState().selectFragment(DETAIL_A.fragments[1]);
    const state = useProjectStore.getState();
    expect(state.selectedFileId).toBe("fa");
    expect(state.activeFragmentId).toBe("fragA2");
  });

  it("locateFromEditorSelection stores fragments and note", async () => {
    const located: LocateResponse = {
      fragments: DETAIL_A.fragments,
      ambiguous: true,
      note: "Выбор пересекает 2 фрагментов",
    };
    const { fetchMock } = mockFetch({ "POST /locate": located });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({ current: PROJECT, selectedFileId: "fa" });

    await useProjectStore.getState().locateFromEditorSelection(5, 6);
    const state = useProjectStore.getState();
    expect(state.locatedFragments).toHaveLength(2);
    expect(state.locatedNote).toBeTruthy();
  });

  it("changes flow: load report, then index creates a job", async () => {
    const { fetchMock, calls } = mockFetch({
      "/changes": CHANGES,
      "POST /index": mockResponse(202, job("queued")),
    });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({ current: PROJECT });

    await useProjectStore.getState().loadChanges();
    expect(useProjectStore.getState().changes?.new).toHaveLength(1);

    await useProjectStore.getState().startIndex();
    expect(useProjectStore.getState().activeJob?.id).toBe("job1");
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/index"))).toBe(true);
    // The changes dialog closes when the job starts.
    expect(useProjectStore.getState().changes).toBeNull();
  });

  it("job polling stops at terminal state and refreshes files", async () => {
    let jobState: JobInfo = job("running", 1, 3);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/jobs/job1")) {
        return { ok: true, status: 200, json: async () => jobState } as unknown as Response;
      }
      if (url.endsWith("/files")) {
        return { ok: true, status: 200, json: async () => [FILE_A] } as unknown as Response;
      }
      if (url.endsWith("/api/projects/p1")) {
        return { ok: true, status: 200, json: async () => PROJECT } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    useProjectStore.setState({ current: PROJECT, activeJob: job("running", 1, 3) });
    await useProjectStore.getState().tickActiveJob();
    expect(useProjectStore.getState().activeJob?.state).toBe("running");

    jobState = job("done", 3, 3);
    await useProjectStore.getState().tickActiveJob();
    expect(useProjectStore.getState().activeJob?.state).toBe("done");
    // Files refreshed after completion.
    expect(useProjectStore.getState().files).toEqual([FILE_A]);
  });

  it("surfaces API errors with code and hint", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects": mockResponse(403, {
        error: { code: "forbidden_host", message: "bad host", hint: "use localhost" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await useProjectStore.getState().loadProjects();
    const error = useProjectStore.getState().error;
    expect(error?.code).toBe("forbidden_host");
    expect(error?.hint).toBe("use localhost");
  });
});

describe("staleness indicator", () => {
  const STALE = {
    dirty: true,
    new_count: 2,
    modified_count: 1,
    deleted_count: 0,
    unchanged_count: 5,
    root_errors: [],
  };

  it("checkStaleness stores the report", async () => {
    const { fetchMock } = mockFetch({ "/staleness": STALE });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({ current: PROJECT });

    await useProjectStore.getState().checkStaleness();
    expect(useProjectStore.getState().staleness).toEqual(STALE);
  });

  it("skips polling while an indexing job runs", async () => {
    const { fetchMock, calls } = mockFetch({ "/staleness": STALE });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({ current: PROJECT, activeJob: job("running", 1, 3) });

    await useProjectStore.getState().checkStaleness();
    expect(calls).toHaveLength(0);
    expect(useProjectStore.getState().staleness).toBeNull();
  });

  it("fails silently (no error banner) when backend is unreachable", async () => {
    const { fetchMock } = mockFetch({
      "/staleness": mockReject(new TypeError("Failed to fetch")),
    });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({ current: PROJECT, staleness: STALE });

    await useProjectStore.getState().checkStaleness();
    const state = useProjectStore.getState();
    expect(state.staleness).toBeNull();
    expect(state.error).toBeNull();
  });
});
