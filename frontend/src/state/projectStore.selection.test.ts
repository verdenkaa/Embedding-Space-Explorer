/**
 * projectStore multi-selection tests (stage 3): the selection state shared by
 * 3D scene, 2D map, fragment lists and Monaco (TZ §4.4, §8.3, §15.2).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileContent, FileDetail, FragmentMeta } from "../api/types";
import { mockFetch } from "../testUtils";
import { useProjectStore } from "./projectStore";

const FRAGMENT_A: FragmentMeta = {
  id: "fragA",
  file_id: "fa",
  kind: "method",
  name: "m",
  symbol_path: "Cls.m",
  parent_symbol_path: "Cls",
  start_line: 5,
  end_line: 9,
  method: "tree-sitter-python",
  language: "python",
  ordinal: 0,
};

const FRAGMENT_B: FragmentMeta = { ...FRAGMENT_A, id: "fragB", file_id: "fa", name: "b" };
const FRAGMENT_C: FragmentMeta = { ...FRAGMENT_A, id: "fragC", file_id: "fc", name: "c" };

const FILE_DETAIL: FileDetail = {
  file: {
    id: "fa",
    root: "/src",
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
  fragments: [FRAGMENT_A, FRAGMENT_B],
};

const FILE_CONTENT: FileContent = {
  file_id: "fa",
  rel_path: "a.py",
  language: "python",
  content: "class Cls:\n    def m(self):\n        pass\n",
  total_lines: 4,
};

function stubFiles() {
  const { fetchMock } = mockFetch({
    "/files/fa/content": FILE_CONTENT,
    "/files/fa": FILE_DETAIL,
    "/files/fc/content": { ...FILE_CONTENT, file_id: "fc", rel_path: "c.py" },
    "/files/fc": { ...FILE_DETAIL, file: { ...FILE_DETAIL.file, id: "fc", rel_path: "c.py" } },
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubFiles();
  useProjectStore.setState({
    current: { id: "p1", name: "Sample" } as never,
    selectedFileId: null,
    fileDetail: null,
    fileContent: null,
    activeFragmentId: null,
    selectedFragmentIds: [],
    locatedFragments: null,
    locatedNote: null,
    error: null,
    loading: false,
  });
});

describe("multi-selection", () => {
  it("single selection sets both the active fragment and the multi-set", async () => {
    await useProjectStore.getState().selectFragment(FRAGMENT_A);
    const s = useProjectStore.getState();
    expect(s.activeFragmentId).toBe("fragA");
    expect(s.selectedFragmentIds).toEqual(["fragA"]);
  });

  it("ctrl-click toggle adds without losing the previous selection", async () => {
    await useProjectStore.getState().selectFragment(FRAGMENT_A);
    await useProjectStore.getState().toggleFragmentSelection(FRAGMENT_B);
    const s = useProjectStore.getState();
    expect(s.selectedFragmentIds).toEqual(["fragA", "fragB"]);
    expect(s.activeFragmentId).toBe("fragB"); // active follows the click
  });

  it("ctrl-click toggle removes and moves the active to the last remaining", async () => {
    useProjectStore.setState({ selectedFragmentIds: ["fragA", "fragB"], activeFragmentId: "fragB" });
    await useProjectStore.getState().toggleFragmentSelection(FRAGMENT_B);
    const s = useProjectStore.getState();
    expect(s.selectedFragmentIds).toEqual(["fragA"]);
    expect(s.activeFragmentId).toBe("fragA");
  });

  it("removing the last selected fragment clears the active one", async () => {
    useProjectStore.setState({ selectedFragmentIds: ["fragA"], activeFragmentId: "fragA" });
    await useProjectStore.getState().toggleFragmentSelection(FRAGMENT_A);
    const s = useProjectStore.getState();
    expect(s.selectedFragmentIds).toEqual([]);
    expect(s.activeFragmentId).toBeNull();
  });

  it("marquee selection replaces the multi-set and keeps the active fragment stable", () => {
    useProjectStore.setState({ activeFragmentId: "fragA", selectedFragmentIds: ["fragA"] });
    useProjectStore.getState().setSelectedFragments(["fragB", "fragC", "fragD"]);
    const s = useProjectStore.getState();
    expect(s.selectedFragmentIds).toEqual(["fragB", "fragC", "fragD"]);
    expect(s.activeFragmentId).toBe("fragA"); // inspector must not jump on area-select
  });

  it("clearSelection resets active, multi-set and located fragments", async () => {
    await useProjectStore.getState().selectFragment(FRAGMENT_A);
    useProjectStore.setState({ locatedFragments: [FRAGMENT_B], locatedNote: "note" });
    useProjectStore.getState().clearSelection();
    const s = useProjectStore.getState();
    expect(s.activeFragmentId).toBeNull();
    expect(s.selectedFragmentIds).toEqual([]);
    expect(s.locatedFragments).toBeNull();
    expect(s.locatedNote).toBeNull();
  });

  it("selectFragment from another file loads that file first (traceability)", async () => {
    useProjectStore.setState({ selectedFileId: "fa" });
    await useProjectStore.getState().selectFragment(FRAGMENT_C);
    const s = useProjectStore.getState();
    expect(s.selectedFileId).toBe("fc"); // file switch happened
    expect(s.activeFragmentId).toBe("fragC");
    expect(s.selectedFragmentIds).toEqual(["fragC"]);
  });

  it("opening another project clears the selection", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p2": {
        id: "p2",
        name: "Other",
        created_at: "",
        updated_at: "",
        roots: [],
        split_options: {} as never,
        stats: null,
      },
      "/api/projects/p2/files": [],
    });
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({
      activeFragmentId: "fragA",
      selectedFragmentIds: ["fragA", "fragB"],
    });
    await useProjectStore.getState().openProject("p2");
    const s = useProjectStore.getState();
    expect(s.activeFragmentId).toBeNull();
    expect(s.selectedFragmentIds).toEqual([]);
  });
});
