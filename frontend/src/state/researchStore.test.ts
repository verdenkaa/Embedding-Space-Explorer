/**
 * researchStore logic tests with a routed fetch mock: tree loading,
 * file/dir selection, create/rename/delete flows, project binding
 * (no writes without a project; stale responses after a switch ignored),
 * open-folder error surfacing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo, WorkspaceEntry, WorkspaceTreeResponse } from "../api/types";
import { mockFetch, mockResponse } from "../testUtils";
import { useMarkdownStore } from "./markdownStore";
import { useProjectStore } from "./projectStore";
import { useResearchStore } from "./researchStore";

const PROJECT = { id: "p1", name: "Sample" } as ProjectInfo;

function entry(path: string, kind: "dir" | "file" = "file"): WorkspaceEntry {
  return { path, name: path.split("/").pop() ?? path, kind, size: 10, mtime: 100 };
}

const TREE: WorkspaceTreeResponse = {
  entries: [entry("notes", "dir"), entry("notes/a.md"), entry("notebooks", "dir")],
  truncated: false,
  root: "/data/projects/p1/workspace",
};

const FILE_A = { path: "notes/a.md", content: "# A", size: 3, mtime: 100 };

function setProject(project: ProjectInfo | null) {
  useProjectStore.setState({ current: project } as never);
}

beforeEach(() => {
  useResearchStore.getState().reset();
  useMarkdownStore.getState().reset();
  setProject(PROJECT);
  vi.unstubAllGlobals();
});

describe("loadTree", () => {
  it("loads entries and root for the current project", async () => {
    const { fetchMock, calls } = mockFetch({ "/api/projects/p1/workspace/tree": TREE });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().loadTree();
    const s = useResearchStore.getState();
    expect(s.tree?.length).toBe(3);
    expect(s.treeRoot).toBe(TREE.root);
    expect(s.treeLoading).toBe(false);
    expect(calls[0].url).toContain("/api/projects/p1/workspace/tree");
  });

  it("does nothing without a project", async () => {
    setProject(null);
    const { fetchMock } = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().loadTree();
    expect(useResearchStore.getState().tree).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records API errors with code and hint", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/workspace/tree": mockResponse(500, {
        error: { code: "workspace_error", message: "boom", hint: "почини" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().loadTree();
    const s = useResearchStore.getState();
    expect(s.error?.code).toBe("workspace_error");
    expect(s.error?.hint).toBe("почини");
  });

  it("ignores a late response after the project changed", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const gatedFetch = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => TREE } as unknown as Response;
    });
    vi.stubGlobal("fetch", gatedFetch);
    const pending = useResearchStore.getState().loadTree();
    setProject({ id: "p2", name: "Other" } as ProjectInfo);
    release(null);
    await pending;
    expect(useResearchStore.getState().tree).toBeNull();
    expect(gatedFetch).toHaveBeenCalled();
  });
});

describe("selectPath", () => {
  it("loads file content for files", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "/api/projects/p1/workspace/file": FILE_A,
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().loadTree();
    await useResearchStore.getState().selectPath("notes/a.md");
    expect(useResearchStore.getState().file?.content).toBe("# A");
  });

  it("selects directories without loading content", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "/api/projects/p1/workspace/file": FILE_A,
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().loadTree();
    await useResearchStore.getState().selectPath("notes");
    const s = useResearchStore.getState();
    expect(s.selectedPath).toBe("notes");
    expect(s.file).toBeNull();
    expect(calls.filter((c) => c.url.includes("/workspace/file")).length).toBe(0);
  });
});

describe("createPath / renamePath / deletePath", () => {
  it("creates a file, reloads the tree and selects it", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /api/projects/p1/workspace/file": entry("notes/new.md"),
      "PUT /api/projects/p1/workspace/file": { ...FILE_A, path: "notes/new.md" },
      "/api/projects/p1/workspace/tree": TREE,
    });
    vi.stubGlobal("fetch", fetchMock);
    const ok = await useResearchStore.getState().createPath("notes/new.md", "file", "# new");
    expect(ok).toBe(true);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ path: "notes/new.md", content: "# new", kind: "file" });
    // tree reload happened after create
    expect(calls.filter((c) => c.url.includes("/workspace/tree")).length).toBe(1);
    expect(useResearchStore.getState().selectedPath).toBe("notes/new.md");
  });

  it("surfaces a 409 create conflict as an error", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/projects/p1/workspace/file": mockResponse(409, {
        error: { code: "workspace_exists", message: "уже существует" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const ok = await useResearchStore.getState().createPath("notes/a.md", "file", "");
    expect(ok).toBe(false);
    expect(useResearchStore.getState().error?.code).toBe("workspace_exists");
  });

  it("rename keeps selection following the new path", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "/api/projects/p1/workspace/file": FILE_A,
      "POST /api/projects/p1/workspace/rename": entry("notes/b.md"),
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().loadTree();
    await useResearchStore.getState().selectPath("notes/a.md");
    const ok = await useResearchStore.getState().renamePath("notes/a.md", "notes/b.md");
    expect(ok).toBe(true);
    const rename = calls.find((c) => c.url.includes("/workspace/rename"));
    expect(rename?.body).toEqual({ from_path: "notes/a.md", to_path: "notes/b.md" });
    expect(useResearchStore.getState().selectedPath).toBe("notes/b.md");
  });

  it("delete clears selection when the selected file was removed", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "/api/projects/p1/workspace/file": FILE_A,
      "DELETE /api/projects/p1/workspace/file": { deleted: "notes/a.md" },
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().loadTree();
    await useResearchStore.getState().selectPath("notes/a.md");
    const ok = await useResearchStore.getState().deletePath("notes/a.md");
    expect(ok).toBe(true);
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("path=notes%2Fa.md");
    expect(useResearchStore.getState().selectedPath).toBeNull();
    expect(useResearchStore.getState().file).toBeNull();
  });

  it("delete of a directory passes confirm", async () => {
    const { fetchMock, calls } = mockFetch({
      "DELETE /api/projects/p1/workspace/file": { deleted: "notes" },
      "/api/projects/p1/workspace/tree": TREE,
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().deletePath("notes", true);
    expect(calls.find((c) => c.method === "DELETE")?.url).toContain("confirm=true");
  });
});

describe("openFolder", () => {
  it("sets a notice when the OS opened the folder", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/projects/p1/workspace/open-folder": {
        opened: true,
        path: "/data/projects/p1/workspace",
        error: null,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().openFolder("");
    expect(useResearchStore.getState().notice).toContain("Папка открыта");
  });

  it("shows a copyable path when opening failed", async () => {
    const { fetchMock } = mockFetch({
      "POST /api/projects/p1/workspace/open-folder": {
        opened: false,
        path: "/data/projects/p1/workspace",
        error: "xdg-open не найден",
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await useResearchStore.getState().openFolder("");
    const s = useResearchStore.getState();
    expect(s.error?.code).toBe("open_folder_failed");
    expect(s.error?.hint).toContain("/data/projects/p1/workspace");
  });
});

describe("dirty markdown note guards", () => {
  function seedDirtyNote() {
    useMarkdownStore.setState({
      doc: {
        path: "notes/a.md",
        projectId: "p1",
        content: "# edited",
        savedContent: "# A",
        savedMtime: 100,
      },
      dirty: true,
    } as never);
  }

  it("selectPath flushes a dirty note before switching", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "GET /api/projects/p1/workspace/file": { ...FILE_A, path: "notes/b.md", content: "# B" },
      "PUT /api/projects/p1/workspace/file": {
        path: "notes/a.md",
        content: "# edited",
        size: 8,
        mtime: 200,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    seedDirtyNote();
    await useResearchStore.getState().loadTree();
    await useResearchStore.getState().selectPath("notes/b.md");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({
      path: "notes/a.md",
      content: "# edited",
      base_mtime: 100,
    });
    expect(useResearchStore.getState().selectedPath).toBe("notes/b.md");
  });

  it("selectPath stays when the flush fails and the user cancels", async () => {
    const { fetchMock } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "GET /api/projects/p1/workspace/file": FILE_A,
      "PUT /api/projects/p1/workspace/file": mockResponse(409, {
        error: { code: "workspace_conflict", message: "изменён на диске" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    seedDirtyNote();
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(false);
    await useResearchStore.getState().loadTree();
    await useResearchStore.getState().selectPath("notes/b.md");
    expect(useResearchStore.getState().selectedPath).toBeNull();
    expect(useMarkdownStore.getState().dirty).toBe(true);
    confirmMock.mockRestore();
  });

  it("rename saves the dirty note into the OLD path before renaming", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "GET /api/projects/p1/workspace/file": FILE_A,
      "PUT /api/projects/p1/workspace/file": { ...FILE_A, content: "# edited", mtime: 200 },
      "POST /api/projects/p1/workspace/rename": entry("notes/b.md"),
    });
    vi.stubGlobal("fetch", fetchMock);
    seedDirtyNote();
    await useResearchStore.getState().loadTree();
    const ok = await useResearchStore.getState().renamePath("notes/a.md", "notes/b.md");
    expect(ok).toBe(true);
    const putIndex = calls.findIndex((c) => c.method === "PUT");
    const renameIndex = calls.findIndex((c) => c.url.includes("/workspace/rename"));
    expect(putIndex).toBeGreaterThanOrEqual(0);
    expect(renameIndex).toBeGreaterThan(putIndex);
    expect(useMarkdownStore.getState().doc).toBeNull();
  });

  it("delete asks about a dirty note; cancel keeps everything", async () => {
    const { fetchMock, calls } = mockFetch({
      "/api/projects/p1/workspace/tree": TREE,
      "DELETE /api/projects/p1/workspace/file": { deleted: "notes/a.md" },
    });
    vi.stubGlobal("fetch", fetchMock);
    seedDirtyNote();
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(false);
    const aborted = await useResearchStore.getState().deletePath("notes/a.md");
    expect(aborted).toBe(false);
    expect(calls.find((c) => c.method === "DELETE")).toBeUndefined();
    expect(useMarkdownStore.getState().doc).not.toBeNull();

    confirmMock.mockReturnValue(true);
    const ok = await useResearchStore.getState().deletePath("notes/a.md");
    expect(ok).toBe(true);
    expect(useMarkdownStore.getState().doc).toBeNull();
    confirmMock.mockRestore();
  });
});
