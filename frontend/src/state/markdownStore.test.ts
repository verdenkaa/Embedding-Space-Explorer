/**
 * markdownStore logic tests (routed fetch mock, same style as
 * notebookStore/researchStore tests): open/save with base_mtime, dirty by
 * comparison, 409 conflict → force decision, reload, external-change
 * recheck (clean refresh vs dirty conflict), project binding of saves.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo } from "../api/types";
import { mockFetch, mockResponse } from "../testUtils";
import { useMarkdownStore } from "./markdownStore";
import { useProjectStore } from "./projectStore";

const PROJECT = { id: "p1", name: "Sample" } as ProjectInfo;
const FILE = { path: "notes/a.md", content: "# A\n\n$\\cos(\\theta)$", size: 20, mtime: 100 };

function setProject(project: ProjectInfo | null) {
  useProjectStore.setState({ current: project } as never);
}

/** Standard route table; override pieces per test. */
function stubApi(routes: Record<string, unknown> = {}) {
  const { fetchMock, calls } = mockFetch({
    "GET /api/projects/p1/workspace/file": FILE,
    "PUT /api/projects/p1/workspace/file": { ...FILE, mtime: 200 },
    ...routes,
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

beforeEach(() => {
  useMarkdownStore.getState().reset();
  setProject(PROJECT);
  vi.unstubAllGlobals();
});

describe("open", () => {
  it("loads the document, clean, default WYSIWYG mode", async () => {
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    const s = useMarkdownStore.getState();
    expect(s.doc?.content).toBe(FILE.content);
    expect(s.doc?.savedContent).toBe(FILE.content);
    expect(s.doc?.savedMtime).toBe(100);
    expect(s.dirty).toBe(false);
    expect(s.mode).toBe("wysiwyg");
    expect(s.loading).toBe(false);
    expect(s.reloadToken).toBeGreaterThan(0);
  });

  it("records errors (missing file) without a document", async () => {
    stubApi({
      "GET /api/projects/p1/workspace/file": mockResponse(404, {
        error: { code: "workspace_not_found", message: "нет файла", hint: "обновите дерево" },
      }),
    });
    await useMarkdownStore.getState().open("p1", "notes/gone.md");
    const s = useMarkdownStore.getState();
    expect(s.doc).toBeNull();
    expect(s.error?.code).toBe("workspace_not_found");
    expect(s.loading).toBe(false);
  });

  it("ignores a stale response after the project switched", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return { ok: true, status: 200, json: async () => FILE } as unknown as Response;
      }),
    );
    const pending = useMarkdownStore.getState().open("p1", "notes/a.md");
    setProject({ id: "p2", name: "Other" } as ProjectInfo);
    release(null);
    await pending;
    expect(useMarkdownStore.getState().doc).toBeNull();
  });
});

describe("editing and save", () => {
  it("setContent marks dirty by comparison; undoing to saved text clears it", async () => {
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    useMarkdownStore.getState().setContent("# A changed");
    expect(useMarkdownStore.getState().dirty).toBe(true);
    useMarkdownStore.getState().setContent(FILE.content);
    expect(useMarkdownStore.getState().dirty).toBe(false);
  });

  it("save sends base_mtime and clears dirty; notice is shown unless silent", async () => {
    const { calls } = stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    useMarkdownStore.getState().setContent("# A v2");
    const ok = await useMarkdownStore.getState().save();
    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ path: "notes/a.md", content: "# A v2", base_mtime: 100 });
    const s = useMarkdownStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.doc?.savedMtime).toBe(200);
    expect(s.doc?.savedContent).toBe("# A v2");
    expect(s.notice).toContain("Сохранено");

    useMarkdownStore.getState().setContent("# A v3");
    await useMarkdownStore.getState().save({ silent: true });
    expect(useMarkdownStore.getState().notice).toContain("Сохранено: notes/a.md"); // previous notice kept
  });

  it("409 on save sets conflict; force-save sends force without base_mtime", async () => {
    stubApi({
      "PUT /api/projects/p1/workspace/file": mockResponse(409, {
        error: { code: "workspace_conflict", message: "изменён на диске" },
      }),
    });
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    useMarkdownStore.getState().setContent("# A v2");
    const ok = await useMarkdownStore.getState().save();
    expect(ok).toBe(false);
    expect(useMarkdownStore.getState().conflict).toBe(true);
    expect(useMarkdownStore.getState().dirty).toBe(true);

    // User chose "Перезаписать": the PUT route now succeeds.
    const second = stubApi({
      "GET /api/projects/p1/workspace/file": FILE,
      "PUT /api/projects/p1/workspace/file": { ...FILE, mtime: 300 },
    });
    const forced = await useMarkdownStore.getState().save({ force: true });
    expect(forced).toBe(true);
    const put = second.calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ force: true, base_mtime: null });
    const s = useMarkdownStore.getState();
    expect(s.conflict).toBe(false);
    expect(s.dirty).toBe(false);
    expect(s.doc?.savedMtime).toBe(300);
  });

  it("keeps dirty when the text changed while the save was in flight", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    useMarkdownStore.getState().setContent("# v2");
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "PUT") {
          await gate;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ...FILE, content: "# v2", mtime: 200 }),
          } as unknown as Response;
        }
        return realFetch(input as string, init);
      }),
    );
    const pending = useMarkdownStore.getState().save();
    useMarkdownStore.getState().setContent("# v3 typed during save");
    release(null);
    const ok = await pending;
    expect(ok).toBe(true);
    const s = useMarkdownStore.getState();
    expect(s.dirty).toBe(true); // "# v3…" never reached the disk
    expect(s.doc?.content).toBe("# v3 typed during save");
    expect(s.doc?.savedContent).toBe("# v2");
  });

  it("saves into its OWN project after a project switch", async () => {
    const { calls } = stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    useMarkdownStore.getState().setContent("# v2");
    setProject({ id: "p2", name: "Other" } as ProjectInfo);
    await useMarkdownStore.getState().flushAndReset();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/api/projects/p1/");
    expect(useMarkdownStore.getState().doc).toBeNull();
  });
});

describe("reload and external changes", () => {
  it("reload replaces unsaved content and bumps reloadToken", async () => {
    stubApi({ "GET /api/projects/p1/workspace/file": { ...FILE, content: "# disk", mtime: 150 } });
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    const token = useMarkdownStore.getState().reloadToken;
    useMarkdownStore.getState().setContent("# local");
    await useMarkdownStore.getState().reload();
    const s = useMarkdownStore.getState();
    expect(s.doc?.content).toBe("# disk");
    expect(s.dirty).toBe(false);
    expect(s.conflict).toBe(false);
    expect(s.reloadToken).toBe(token + 1);
  });

  it("recheckExternal silently refreshes a CLEAN document", async () => {
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    const token = useMarkdownStore.getState().reloadToken;
    // The notebook kernel rewrote the note on disk.
    stubApi({ "GET /api/projects/p1/workspace/file": { ...FILE, content: "# from kernel", mtime: 500 } });
    await useMarkdownStore.getState().recheckExternal();
    const s = useMarkdownStore.getState();
    expect(s.doc?.content).toBe("# from kernel");
    expect(s.doc?.savedMtime).toBe(500);
    expect(s.dirty).toBe(false);
    expect(s.conflict).toBe(false);
    expect(s.reloadToken).toBe(token + 1);
    expect(s.notice).toContain("изменён на диске");
  });

  it("recheckExternal sets conflict for a DIRTY document (never overwrites)", async () => {
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    useMarkdownStore.getState().setContent("# my edits");
    stubApi({ "GET /api/projects/p1/workspace/file": { ...FILE, content: "# from kernel", mtime: 500 } });
    await useMarkdownStore.getState().recheckExternal();
    const s = useMarkdownStore.getState();
    expect(s.conflict).toBe(true);
    expect(s.doc?.content).toBe("# my edits"); // local edits intact
  });

  it("recheckExternal is a no-op when the file did not change", async () => {
    const { calls } = stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    const token = useMarkdownStore.getState().reloadToken;
    await useMarkdownStore.getState().recheckExternal();
    const s = useMarkdownStore.getState();
    expect(s.reloadToken).toBe(token);
    expect(s.notice).toBeNull();
    expect(calls.length).toBe(2); // open + recheck, nothing else
  });

  it("recheckExternal reports a file deleted behind the app", async () => {
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    stubApi({
      "GET /api/projects/p1/workspace/file": mockResponse(404, {
        error: { code: "workspace_not_found", message: "нет" },
      }),
    });
    await useMarkdownStore.getState().recheckExternal();
    expect(useMarkdownStore.getState().error?.message).toContain("удалён");
  });

  it("recheckExternal stays quiet when the backend is unreachable", async () => {
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    await useMarkdownStore.getState().recheckExternal();
    expect(useMarkdownStore.getState().error).toBeNull();
  });
});

describe("modes", () => {
  it("open resets the mode to wysiwyg; setMode switches", async () => {
    stubApi();
    await useMarkdownStore.getState().open("p1", "notes/a.md");
    useMarkdownStore.getState().setMode("split");
    expect(useMarkdownStore.getState().mode).toBe("split");
    await useMarkdownStore.getState().open("p1", "notes/b.md");
    expect(useMarkdownStore.getState().mode).toBe("wysiwyg");
  });
});
