/**
 * NotebookEditor component tests (Monaco is mocked like in the inspector
 * tests): document rendering, dirty/save flow, conflict and project-mismatch
 * banners, markdown preview with LaTeX, cell toolbar operations.
 *
 * The editor loads its document via the API on mount, so every test stubs
 * the content route first and waits for the store to fill.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotebookJson } from "../../api/types";
import { mockFetch } from "../../testUtils";
import { useNotebookStore } from "../../state/notebookStore";
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

import { NotebookEditor } from "./NotebookEditor";

function makeNotebook(over: Partial<NotebookJson> = {}): NotebookJson {
  return {
    cells: [
      {
        cell_type: "code",
        id: "c1",
        source: "print('hi')",
        metadata: {},
        outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }],
        execution_count: 3,
      },
      {
        cell_type: "markdown",
        id: "m1",
        source: "# Заголовок\n\nФормула: $\\cos(\\theta)$",
        metadata: {},
      },
    ],
    metadata: { ese: { project_id: "p1" } },
    nbformat: 4,
    nbformat_minor: 5,
    ...over,
  };
}

/** Stub the notebook routes; returns recorded calls for assertions. */
function stubApi(notebook: NotebookJson = makeNotebook(), problems: string[] = []) {
  const { fetchMock, calls } = mockFetch({
    "GET /api/projects/p1/notebooks/content": {
      path: "notebooks/a.ipynb",
      notebook,
      valid: problems.length === 0,
      problems,
      mtime: 100,
      size: 10,
      ese_project_id: (notebook.metadata?.["ese"] as { project_id?: string } | undefined)
        ?.project_id ?? null,
    },
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
  return calls;
}

async function renderEditor(notebook?: NotebookJson, problems?: string[]) {
  const calls = stubApi(notebook, problems);
  render(<NotebookEditor projectId="p1" path="notebooks/a.ipynb" />);
  await waitFor(() => expect(useNotebookStore.getState().doc).not.toBeNull());
  return calls;
}

beforeEach(() => {
  useProjectStore.setState({ current: { id: "p1", name: "P" } } as never);
  useNotebookStore.getState().reset();
  vi.unstubAllGlobals();
});

afterEach(cleanup);

describe("NotebookEditor", () => {
  it("renders code and markdown cells with outputs", async () => {
    await renderEditor();

    expect(screen.getByTestId("nb-cell-0")).toBeTruthy();
    expect(screen.getByTestId("nb-cell-1")).toBeTruthy();
    // execution count and stream output of the code cell
    expect(screen.getByText("[3]")).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();
    // markdown cell is rendered (preview), including KaTeX
    await waitFor(() => {
      const preview = screen.getByTestId("nb-md-preview-1");
      expect(preview.innerHTML).toContain("Заголовок");
      expect(preview.innerHTML).toContain("katex");
    });
  });

  it("shows the kernel placeholder when no session exists", async () => {
    await renderEditor();
    expect(screen.getByText("нет ядра")).toBeTruthy();
  });

  it("marks dirty on edit and saves via Ctrl+S", async () => {
    const calls = await renderEditor();

    const textarea = screen.getAllByTestId("monaco-textarea")[0];
    fireEvent.change(textarea, { target: { value: "x = 1" } });
    await waitFor(() => expect(useNotebookStore.getState().dirty).toBe(true));
    expect(screen.getByText("●", { exact: false })).toBeTruthy();

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(useNotebookStore.getState().dirty).toBe(false));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({ path: "notebooks/a.ipynb", base_mtime: 100 });
    expect(useNotebookStore.getState().doc?.savedMtime).toBe(200);
  });

  it("shows the conflict banner with reload/overwrite actions", async () => {
    await renderEditor();
    // A conflict appears when a save hits 409; simulate the store outcome.
    useNotebookStore.setState({ conflict: true } as never);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("изменён на диске"),
    );
    expect(screen.getByText("Перезагрузить с диска")).toBeTruthy();
    expect(screen.getByText("Перезаписать")).toBeTruthy();
  });

  it("warns when the notebook was created for another project", async () => {
    await renderEditor(makeNotebook({ metadata: { ese: { project_id: "other9" } } }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("другого проекта"),
    );
  });

  it("shows validation problems as a banner", async () => {
    await renderEditor(makeNotebook(), ["ячейка без id"]);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("ячейка без id"),
    );
  });

  it("cell toolbar: add and delete cells", async () => {
    await renderEditor();
    const before = useNotebookStore.getState().doc!.notebook.cells.length;

    const addButtons = screen.getAllByTitle("Добавить ячейку ниже");
    fireEvent.click(addButtons[0]);
    expect(useNotebookStore.getState().doc!.notebook.cells.length).toBe(before + 1);

    const delButtons = screen.getAllByTitle("Удалить ячейку");
    fireEvent.click(delButtons[delButtons.length - 1]);
    expect(useNotebookStore.getState().doc!.notebook.cells.length).toBe(before);
  });
});
