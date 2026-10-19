/**
 * notebookStore logic tests with a routed fetch mock: open/normalize,
 * dirty tracking, save with base_mtime + conflict, cell edits, execution
 * polling (session boot → execute → outputs in the cell), restart counters.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NotebookContentResponse,
  NotebookJson,
} from "../api/types";
import { mockFetch } from "../testUtils";
import { useNotebookStore } from "./notebookStore";
import { useProjectStore } from "./projectStore";

function makeNotebook(over: Partial<NotebookJson> = {}): NotebookJson {
  return {
    cells: [
      {
        cell_type: "code",
        source: ["print(", '"hi")'], // list-form source must normalize to a string
        metadata: {},
        outputs: [],
        execution_count: null,
      },
      { cell_type: "markdown", source: "# Заголовок", metadata: {} },
    ],
    metadata: { ese: { project_id: "p1" } },
    nbformat: 4,
    nbformat_minor: 5,
    ...over,
  };
}

function contentResponse(over: Partial<NotebookContentResponse> = {}): NotebookContentResponse {
  return {
    path: "notebooks/a.ipynb",
    notebook: makeNotebook(),
    valid: true,
    problems: [],
    mtime: 100,
    size: 10,
    ese_project_id: "p1",
    ...over,
  };
}

/** A fetch stub with EXACT "METHOD url" routing whose replies evolve call by call. */
function sequencedFetch(routes: Record<string, unknown[]>) {
  const counters: Record<string, number> = {};
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [key, values] of Object.entries(routes)) {
      const [keyMethod, ...rest] = key.split(" ");
      const hasMethod = ["GET", "POST", "PUT", "DELETE"].includes(keyMethod);
      const pattern = hasMethod ? rest.join(" ") : key;
      const methodMatches = !hasMethod || keyMethod === method;
      if (methodMatches && url === pattern) {
        const idx = counters[key] ?? 0;
        counters[key] = idx + 1;
        const body = values[Math.min(idx, values.length - 1)];
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "not_found", message: `${method} ${url}` } }),
    } as unknown as Response;
  });
}

beforeEach(() => {
  useNotebookStore.getState().reset();
  useProjectStore.setState({ current: { id: "p1", name: "P" } } as never);
  vi.unstubAllGlobals();
});

describe("open", () => {
  it("loads, normalizes sources/ids and records mtime", async () => {
    const { fetchMock } = mockFetch({
      "GET /api/projects/p1/notebooks/content": contentResponse(),
      "GET /api/projects/p1/notebooks/sessions": [],
    });
    vi.stubGlobal("fetch", fetchMock);

    await useNotebookStore.getState().open("p1", "notebooks/a.ipynb");
    const s = useNotebookStore.getState();
    expect(s.doc?.notebook.cells[0].source).toBe('print("hi")');
    expect(s.doc?.notebook.cells[0].id).toBeTruthy();
    expect(s.doc?.savedMtime).toBe(100);
    expect(s.dirty).toBe(false);
    expect(s.session).toBeNull();
  });

  it("re-attaches to a live session of the same notebook", async () => {
    const session = {
      session_id: "s1",
      project_id: "p1",
      path: "notebooks/a.ipynb",
      state: "ready",
      error: null,
      busy: false,
      started_at: 1,
      last_used: 1,
    };
    const { fetchMock } = mockFetch({
      "GET /api/projects/p1/notebooks/content": contentResponse(),
      "GET /api/projects/p1/notebooks/sessions": [session],
    });
    vi.stubGlobal("fetch", fetchMock);
    await useNotebookStore.getState().open("p1", "notebooks/a.ipynb");
    expect(useNotebookStore.getState().session?.session_id).toBe("s1");
  });
});

describe("editing and save", () => {
  async function opened() {
    const { fetchMock, calls } = mockFetch({
      "GET /api/projects/p1/notebooks/content": contentResponse(),
      "GET /api/projects/p1/notebooks/sessions": [],
      "PUT /api/projects/p1/notebooks/content": {
        path: "notebooks/a.ipynb",
        mtime: 200,
        size: 12,
        valid: true,
        problems: [],
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await useNotebookStore.getState().open("p1", "notebooks/a.ipynb");
    return { calls };
  }

  it("setCellSource marks dirty; save sends base_mtime and clears dirty", async () => {
    const { calls } = await opened();
    useNotebookStore.getState().setCellSource(0, "x = 1");
    expect(useNotebookStore.getState().dirty).toBe(true);

    const ok = await useNotebookStore.getState().save();
    expect(ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({
      path: "notebooks/a.ipynb",
      base_mtime: 100,
      force: false,
    });
    const body = put?.body as { notebook: NotebookJson };
    expect(body.notebook.cells[0].source).toBe("x = 1");
    const s = useNotebookStore.getState();
    expect(s.dirty).toBe(false);
    expect(s.doc?.savedMtime).toBe(200);
  });

  it("409 on save sets conflict; force-save sends force without base_mtime", async () => {
    await opened();
    useNotebookStore.getState().setCellSource(0, "x = 1");

    const puts: { body: Record<string, unknown> }[] = [];
    let firstPut = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        puts.push({ body });
        if (firstPut) {
          firstPut = false;
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: { code: "workspace_conflict", message: "changed" } }),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            path: "notebooks/a.ipynb",
            mtime: 300,
            size: 1,
            valid: true,
            problems: [],
          }),
        } as unknown as Response;
      }) as never,
    );

    const failed = await useNotebookStore.getState().save();
    expect(failed).toBe(false);
    expect(useNotebookStore.getState().conflict).toBe(true);

    const forced = await useNotebookStore.getState().save({ force: true });
    expect(forced).toBe(true);
    expect(puts[1].body).toMatchObject({ force: true, base_mtime: null });
    expect(useNotebookStore.getState().conflict).toBe(false);
  });

  it("cell operations keep the document consistent", async () => {
    await opened();
    const st = useNotebookStore.getState();
    st.addCell(0, "markdown");
    let cells = useNotebookStore.getState().doc!.notebook.cells;
    expect(cells.length).toBe(3);
    expect(cells[1].cell_type).toBe("markdown");

    useNotebookStore.getState().moveCell(1, 1);
    cells = useNotebookStore.getState().doc!.notebook.cells;
    expect(cells[2].cell_type).toBe("markdown");

    useNotebookStore.getState().convertCell(2, "code");
    cells = useNotebookStore.getState().doc!.notebook.cells;
    expect(cells[2].cell_type).toBe("code");
    expect(Array.isArray(cells[2].outputs)).toBe(true);

    useNotebookStore.getState().deleteCell(2);
    cells = useNotebookStore.getState().doc!.notebook.cells;
    expect(cells.length).toBe(2);
    expect(useNotebookStore.getState().dirty).toBe(true);
  });
});

describe("execution flow", () => {
  it("boots a session, executes and writes outputs + count into the cell", async () => {
    const sessionStarting = {
      session_id: "s1",
      project_id: "p1",
      path: "notebooks/a.ipynb",
      state: "starting",
      error: null,
      busy: false,
      started_at: 1,
      last_used: 1,
    };
    const sessionReady = { ...sessionStarting, state: "ready" };
    const running = {
      id: "e1",
      status: "running",
      outputs: [],
      execution_count: null,
      error: null,
      truncated: false,
      started_at: 1,
      finished_at: null,
    };
    const done = {
      ...running,
      status: "done",
      outputs: [
        { output_type: "execute_result", data: { "text/plain": "42" }, metadata: {}, execution_count: 1 },
      ],
      execution_count: 1,
      finished_at: 2,
    };

    vi.stubGlobal(
      "fetch",
      sequencedFetch({
        "GET /api/projects/p1/notebooks/content?path=notebooks%2Fa.ipynb": [
          contentResponse(),
        ],
        "GET /api/projects/p1/notebooks/sessions": [[]],
        "POST /api/projects/p1/notebooks/sessions": [sessionStarting],
        "GET /api/projects/p1/notebooks/sessions/s1": [sessionReady],
        "POST /api/projects/p1/notebooks/sessions/s1/execute": [
          { execution_id: "e1", status: "running" },
        ],
        "GET /api/projects/p1/notebooks/sessions/s1/executions/e1": [running, done],
      }),
    );

    await useNotebookStore.getState().open("p1", "notebooks/a.ipynb");
    await useNotebookStore.getState().executeCell(0);

    const s = useNotebookStore.getState();
    expect(s.runningCell).toBeNull();
    const cell = s.doc!.notebook.cells[0];
    expect(cell.execution_count).toBe(1);
    expect(cell.outputs?.[0]).toMatchObject({ output_type: "execute_result" });
    // Outputs changed the document → it must be marked dirty for the save.
    expect(s.dirty).toBe(true);
  });
});

describe("flushAndReset", () => {
  it("saves a dirty document before dropping it", async () => {
    const puts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (init?.method === "PUT") puts.push(url);
        if (url.includes("/notebooks/content") && init?.method !== "PUT") {
          return {
            ok: true,
            status: 200,
            json: async () => contentResponse(),
          } as unknown as Response;
        }
        if (url.includes("/notebooks/sessions")) {
          return { ok: true, status: 200, json: async () => [] } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ path: "notebooks/a.ipynb", mtime: 9, size: 1, valid: true, problems: [] }),
        } as unknown as Response;
      }) as never,
    );

    await useNotebookStore.getState().open("p1", "notebooks/a.ipynb");
    useNotebookStore.getState().setCellSource(0, "changed");
    await useNotebookStore.getState().flushAndReset();
    expect(puts.length).toBe(1);
    expect(useNotebookStore.getState().doc).toBeNull();
  });
});
