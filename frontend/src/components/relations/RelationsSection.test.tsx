/**
 * RelationsSection tests: the project-wide browser (filters, provenance,
 * pagination), extraction job start, import report rendering and the empty
 * state that explains where relations come from (no fake data).
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobInfo, RelationsResponse } from "../../api/types";
import { mockFetch, mockResponse, type RecordedCall } from "../../testUtils";
import { useAnalysisStore } from "../../state/analysisStore";
import { useProjectStore } from "../../state/projectStore";
import { RelationsSection } from "./RelationsSection";

const RELATIONS: RelationsResponse = {
  items: [
    {
      id: "rel1",
      kind: "imports",
      origin: "extracted",
      confidence: 1,
      detail: "pkg.b",
      created_at: "",
      source: {
        file_id: "fa",
        fragment_id: null,
        rel_path: "pkg/a.py",
        name: null,
        symbol_path: null,
        start_line: null,
        end_line: null,
      },
      target: {
        file_id: "fb",
        fragment_id: null,
        rel_path: "pkg/b.py",
        name: null,
        symbol_path: null,
        start_line: null,
        end_line: null,
      },
    },
    {
      id: "rel2",
      kind: "calls",
      origin: "manual",
      confidence: null,
      detail: "ручная",
      created_at: "",
      source: {
        file_id: "fa",
        fragment_id: "fragA",
        rel_path: "pkg/a.py",
        name: "main",
        symbol_path: "main",
        start_line: 5,
        end_line: 6,
      },
      target: {
        file_id: "fb",
        fragment_id: "fragB",
        rel_path: "pkg/b.py",
        name: "helper",
        symbol_path: "helper",
        start_line: 1,
        end_line: 2,
      },
    },
  ],
  total: 120,
  limit: 100,
  offset: 0,
  counts_by_kind: { imports: 100, calls: 20 },
  counts_by_origin: { extracted: 100, manual: 20 },
};

const EXTRACT_JOB: JobInfo = {
  id: "jobR",
  kind: "relations",
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

let fetchCalls: RecordedCall[] = [];

function stub(routes: Record<string, unknown> = {}) {
  const { fetchMock, calls } = mockFetch({
    "/api/projects/p1/relations": RELATIONS,
    "POST /api/projects/p1/relations/extract": mockResponse(202, EXTRACT_JOB),
    ...routes,
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchCalls = calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  useProjectStore.setState({ current: { id: "p1", name: "Sample" } as never });
  useAnalysisStore.getState().reset();
});

afterEach(cleanup);

describe("RelationsSection", () => {
  it("loads and shows the browser with provenance and counts", async () => {
    stub();
    render(<RelationsSection />);
    await waitFor(() => {
      expect(screen.getByText("120 в проекте")).toBeTruthy();
    });
    expect(screen.getByText("imp")).toBeTruthy();
    expect(screen.getByText("call")).toBeTruthy();
    // «извлечено» appears both in the origin filter and as a row badge
    expect(screen.getAllByText("извлечено").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("вручную").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("pkg/a.py")).toBeTruthy();
    // kind filter lists the inventory counts
    const kindSelect = screen.getByLabelText("Фильтр по типу связи") as HTMLSelectElement;
    const options = Array.from(kindSelect.options).map((o) => o.textContent);
    expect(options.some((text) => text?.includes("imports (100)"))).toBe(true);
  });

  it("extraction starts the background job", async () => {
    stub();
    render(<RelationsSection />);
    await waitFor(() => expect(screen.getByText("120 в проекте")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Извлечь связи" }));
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes("/relations/extract"))).toBe(true);
    });
    expect(useAnalysisStore.getState().activeJob?.id).toBe("jobR");
  });

  it("filter change reloads with the query parameter", async () => {
    stub();
    render(<RelationsSection />);
    await waitFor(() => expect(screen.getByText("120 в проекте")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Фильтр по типу связи"), {
      target: { value: "calls" },
    });
    await waitFor(() => {
      const last = fetchCalls.filter((c) => c.url.includes("/relations")).pop();
      expect(last?.url).toContain("kind=calls");
    });
  });

  it("pager reflects the 100-row pages", async () => {
    stub();
    render(<RelationsSection />);
    await waitFor(() => expect(screen.getByText("1–100 из 120")).toBeTruthy());
    const back = screen.getAllByRole("button", { name: "←" })[0];
    expect((back as HTMLButtonElement).disabled).toBe(true);
  });

  it("empty state explains where relations come from", async () => {
    stub({ "/api/projects/p1/relations": { ...RELATIONS, items: [], total: 0 } });
    render(<RelationsSection />);
    await waitFor(() => {
      expect(screen.getByText(/Связей нет/)).toBeTruthy();
    });
    expect(screen.getByText(/ese-relations\/v1/)).toBeTruthy();
    expect(screen.getByText(/не выдаёт догадки за факты/)).toBeTruthy();
  });

  it("import report shows unresolved rows honestly", async () => {
    stub();
    useAnalysisStore.setState({
      lastImportReport: {
        imported: 3,
        duplicates: 1,
        unresolved: [{ index: 4, kind: "calls", reason: "source: file 'x.py' is missing" }],
      },
    });
    render(<RelationsSection />);
    expect(screen.getByText(/добавлено 3/)).toBeTruthy();
    expect(screen.getByText(/не разрешено 1/)).toBeTruthy();
    expect(screen.getByText(/file 'x\.py' is missing/)).toBeTruthy();
  });
});
