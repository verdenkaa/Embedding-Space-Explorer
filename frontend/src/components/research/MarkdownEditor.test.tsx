/**
 * MarkdownEditor component tests. Heavy externals are mocked like in the
 * other editor tests: Monaco → textarea, Allotment → plain divs, Milkdown
 * Crepe → a fake class that renders a textarea and exposes the same
 * create/getMarkdown/destroy/on(markdownUpdated) surface. The flows tested
 * are the editor's own logic: mount, dirty tracking, Ctrl+S, mode switching,
 * KaTeX preview, image src rewriting, conflict banner, external refresh.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectInfo } from "../../api/types";
import { mockFetch, mockResponse } from "../../testUtils";
import { useMarkdownStore } from "../../state/markdownStore";
import { useProjectStore } from "../../state/projectStore";

vi.mock("@monaco-editor/react", () => ({
  Editor: (props: { value?: string; onChange?: (v: string) => void }) => (
    <div data-testid="monaco-editor">
      <textarea
        data-testid="monaco-textarea"
        value={props.value ?? ""}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    </div>
  ),
  loader: { config: vi.fn() },
}));

vi.mock("allotment", () => {
  const Allotment = ({ children }: { children: React.ReactNode }) => (
    <div data-testid="allotment">{children}</div>
  );
  Allotment.Pane = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Allotment, default: Allotment };
});

/* Fake Crepe: mirrors the real lifecycle (constructor → on → create →
   getMarkdown/destroy) with a textarea as the editing surface. */
const crepeMocks = vi.hoisted(() => {
  interface FakeCrepeInstance {
    cfg: { root?: HTMLElement; defaultValue?: string };
    textarea: HTMLTextAreaElement | null;
    mdListener: ((ctx: unknown, md: string, prev: string) => void) | null;
    destroyed: boolean;
  }
  const instances: FakeCrepeInstance[] = [];
  class FakeCrepe implements FakeCrepeInstance {
    cfg: { root?: HTMLElement; defaultValue?: string };
    textarea: HTMLTextAreaElement | null = null;
    mdListener: ((ctx: unknown, md: string, prev: string) => void) | null = null;
    destroyed = false;
    constructor(cfg: { root?: HTMLElement; defaultValue?: string }) {
      this.cfg = cfg ?? {};
      instances.push(this);
    }
    on(fn: (api: unknown) => void) {
      fn({
        markdownUpdated: (cb: (ctx: unknown, md: string, prev: string) => void) => {
          this.mdListener = cb;
          return this;
        },
        updated: () => this,
        mounted: () => this,
        beforeMount: () => this,
        blur: () => this,
        focus: () => this,
        destroy: () => this,
        selectionUpdated: () => this,
      });
      return this;
    }
    async create() {
      const ta = document.createElement("textarea");
      ta.setAttribute("data-testid", "crepe-textarea");
      ta.value = this.cfg.defaultValue ?? "";
      ta.addEventListener("input", () => this.mdListener?.({}, ta.value, ""));
      this.cfg.root?.appendChild(ta);
      this.textarea = ta;
    }
    getMarkdown() {
      return this.textarea?.value ?? this.cfg.defaultValue ?? "";
    }
    async destroy() {
      this.destroyed = true;
      this.textarea?.remove();
      this.textarea = null;
    }
    setReadonly() {
      return this;
    }
  }
  return { instances, FakeCrepe };
});

vi.mock("@milkdown/crepe", () => ({
  Crepe: crepeMocks.FakeCrepe,
  CrepeFeature: {
    CodeMirror: "code-mirror",
    ListItem: "list-item",
    LinkTooltip: "link-tooltip",
    Cursor: "cursor",
    ImageBlock: "image-block",
    BlockEdit: "block-edit",
    Toolbar: "toolbar",
    Placeholder: "placeholder",
    Table: "table",
    Latex: "latex",
    TopBar: "top-bar",
    AI: "ai",
  },
}));

import { MarkdownEditor } from "./MarkdownEditor";

const PROJECT = { id: "p1", name: "Sample" } as ProjectInfo;
const NOTE = "# Заметка\n\nФормула: $\\cos(\\theta)$\n\n![plot](../results/p.png)\n";
const FILE = { path: "notes/a.md", content: NOTE, size: NOTE.length, mtime: 100 };

function stubApi(routes: Record<string, unknown> = {}) {
  const { fetchMock, calls } = mockFetch({
    "GET /api/projects/p1/workspace/file": FILE,
    "PUT /api/projects/p1/workspace/file": { ...FILE, mtime: 200 },
    ...routes,
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function renderEditor() {
  return render(<MarkdownEditor projectId="p1" path="notes/a.md" />);
}

async function waitCrepe(): Promise<HTMLTextAreaElement> {
  return (await screen.findByTestId("crepe-textarea")) as HTMLTextAreaElement;
}

beforeEach(() => {
  useMarkdownStore.getState().reset();
  useProjectStore.setState({ current: PROJECT } as never);
  crepeMocks.instances.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("mount and WYSIWYG mode", () => {
  it("opens the note and mounts Crepe with its content (default mode)", async () => {
    stubApi();
    renderEditor();
    const ta = await waitCrepe();
    expect(ta.value).toBe(NOTE);
    expect(useMarkdownStore.getState().mode).toBe("wysiwyg");
    expect(screen.getByText("notes/a.md", { selector: ".note-toolbar__path" })).toBeTruthy();
  });

  it("Crepe edits mark the document dirty and reach the store", async () => {
    stubApi();
    renderEditor();
    const ta = await waitCrepe();
    const saveBtn = screen.getByRole("button", { name: /Сохранить/ });
    expect(saveBtn).toHaveProperty("disabled", true);
    ta.value = `${NOTE}\nНовая строка`;
    fireEvent.input(ta);
    await waitFor(() => expect(useMarkdownStore.getState().dirty).toBe(true));
    expect(useMarkdownStore.getState().doc?.content).toContain("Новая строка");
    expect(screen.getByTitle("Есть несохранённые изменения")).toBeTruthy();
    expect(saveBtn).toHaveProperty("disabled", false);
  });

  it("Ctrl+S saves with base_mtime and clears the dirty mark", async () => {
    const { calls } = stubApi();
    renderEditor();
    const ta = await waitCrepe();
    ta.value = "# v2";
    fireEvent.input(ta);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(useMarkdownStore.getState().dirty).toBe(false));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ path: "notes/a.md", content: "# v2", base_mtime: 100 });
    expect(useMarkdownStore.getState().doc?.savedMtime).toBe(200);
  });
});

describe("modes", () => {
  it("source mode shows Monaco with the raw markdown and edits mark dirty", async () => {
    stubApi();
    renderEditor();
    await waitCrepe();
    fireEvent.click(screen.getByRole("button", { name: "Исходник" }));
    const monaco = (await screen.findByTestId("monaco-textarea")) as HTMLTextAreaElement;
    expect(monaco.value).toBe(NOTE);
    fireEvent.change(monaco, { target: { value: "# raw edit" } });
    await waitFor(() => expect(useMarkdownStore.getState().doc?.content).toBe("# raw edit"));
    expect(useMarkdownStore.getState().dirty).toBe(true);
  });

  it("preview mode renders LaTeX with KaTeX (same pipeline as export)", async () => {
    stubApi();
    renderEditor();
    await waitCrepe();
    fireEvent.click(screen.getByRole("button", { name: "Просмотр" }));
    const preview = await screen.findByTestId("note-preview");
    expect(preview.querySelector(".katex")).toBeTruthy();
    expect(preview.textContent).toContain("Заметка");
  });

  it("split mode shows source and preview together", async () => {
    stubApi();
    renderEditor();
    await waitCrepe();
    fireEvent.click(screen.getByRole("button", { name: "Сплит" }));
    expect(await screen.findByTestId("allotment")).toBeTruthy();
    expect(screen.getByTestId("monaco-textarea")).toBeTruthy();
    expect(screen.getByTestId("note-preview")).toBeTruthy();
  });

  it("preview rewrites relative image sources to the workspace raw route", async () => {
    stubApi();
    renderEditor();
    await waitCrepe();
    fireEvent.click(screen.getByRole("button", { name: "Просмотр" }));
    const preview = await screen.findByTestId("note-preview");
    const img = preview.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      `/api/projects/p1/workspace/raw?path=${encodeURIComponent("results/p.png")}`,
    );
    expect(img?.getAttribute("data-ese-src")).toBe("../results/p.png");
    expect(img?.getAttribute("alt")).toBe("plot");
  });

  it("switching back to WYSIWYG remounts Crepe with the edited content", async () => {
    stubApi();
    renderEditor();
    await waitCrepe();
    fireEvent.click(screen.getByRole("button", { name: "Исходник" }));
    const monaco = (await screen.findByTestId("monaco-textarea")) as HTMLTextAreaElement;
    fireEvent.change(monaco, { target: { value: "# после правки" } });
    fireEvent.click(screen.getByRole("button", { name: "Текст" }));
    const ta = (await screen.findByTestId("crepe-textarea")) as HTMLTextAreaElement;
    expect(ta.value).toBe("# после правки");
    expect(crepeMocks.instances.length).toBe(2);
    expect(crepeMocks.instances[0].destroyed).toBe(true);
  });
});

describe("conflicts and external changes", () => {
  it("409 on save shows the conflict banner; «Перезаписать» force-saves", async () => {
    stubApi({
      "PUT /api/projects/p1/workspace/file": mockResponse(409, {
        error: { code: "workspace_conflict", message: "изменён на диске" },
      }),
    });
    renderEditor();
    const ta = await waitCrepe();
    ta.value = "# v2";
    fireEvent.input(ta);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/изменён на диске/)).toBeTruthy();

    const second = stubApi({
      "GET /api/projects/p1/workspace/file": FILE,
      "PUT /api/projects/p1/workspace/file": { ...FILE, mtime: 300 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Перезаписать" }));
    await waitFor(() => expect(useMarkdownStore.getState().dirty).toBe(false));
    const put = second.calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ force: true, base_mtime: null });
  });

  it("«Перезагрузить с диска» replaces the content and remounts Crepe", async () => {
    stubApi();
    renderEditor();
    const ta = await waitCrepe();
    ta.value = "# локальная правка";
    fireEvent.input(ta);
    // External edit surfaces as a conflict on save.
    stubApi({
      "GET /api/projects/p1/workspace/file": { ...FILE, content: "# с диска", mtime: 900 },
      "PUT /api/projects/p1/workspace/file": mockResponse(409, {
        error: { code: "workspace_conflict", message: "изменён на диске" },
      }),
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(await screen.findByRole("button", { name: "Перезагрузить с диска" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Перезагрузить с диска" }));
    await waitFor(() => expect(useMarkdownStore.getState().doc?.content).toBe("# с диска"));
    const remounted = (await screen.findByTestId("crepe-textarea")) as HTMLTextAreaElement;
    expect(remounted.value).toBe("# с диска");
    expect(useMarkdownStore.getState().dirty).toBe(false);
  });

  it("window focus silently refreshes a clean document (kernel wrote the note)", async () => {
    stubApi();
    renderEditor();
    await waitCrepe();
    stubApi({
      "GET /api/projects/p1/workspace/file": { ...FILE, content: "# из ядра", mtime: 900 },
    });
    fireEvent.focus(window);
    await waitFor(() => expect(useMarkdownStore.getState().doc?.content).toBe("# из ядра"));
    const ta = (await screen.findByTestId("crepe-textarea")) as HTMLTextAreaElement;
    expect(ta.value).toBe("# из ядра");
  });
});

describe("loading and errors", () => {
  it("shows a readable error when the note cannot be opened", async () => {
    stubApi({
      "GET /api/projects/p1/workspace/file": mockResponse(404, {
        error: { code: "workspace_not_found", message: "Файл не найден: notes/a.md" },
      }),
    });
    renderEditor();
    expect(await screen.findByText(/Файл не найден/)).toBeTruthy();
    expect(screen.queryByTestId("crepe-textarea")).toBeNull();
  });
});
