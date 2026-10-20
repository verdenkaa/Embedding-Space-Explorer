/**
 * ExperimentsPanel tests: model cards with honest download status, mode
 * selector with exact template preview, compute gating, runs table coverage.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingRunDTO, JobInfo, ModelInfo, PreparationPreviews } from "../api/types";
import { useExperimentStore } from "../state/experimentStore";
import { useProjectStore } from "../state/projectStore";
import { mockFetch, mockResponse } from "../testUtils";
import { ExperimentsPanel } from "./ExperimentsPanel";

const MODELS: ModelInfo[] = [
  {
    model_id: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    display_name: "paraphrase-multilingual-MiniLM-L12-v2",
    dim: 384,
    approx_download_mb: 470,
    description: "Мультиязычная модель; НЕ специализирована на коде",
    is_default: true,
    downloaded: true,
  },
  {
    model_id: "sentence-transformers/all-MiniLM-L6-v2",
    display_name: "all-MiniLM-L6-v2",
    dim: 384,
    approx_download_mb: 90,
    description: "Компактная модель",
    is_default: false,
    downloaded: false,
  },
];

const PREVIEWS: PreparationPreviews = {
  raw_fragment: "<только текст фрагмента, без метаданных>",
  context_enriched: "# path: src/app/calculator.py\n# symbol: Calculator.add",
};

const RUN: EmbeddingRunDTO = {
  id: "fp1",
  model_id: MODELS[0].model_id,
  model_display_name: MODELS[0].display_name,
  dim: 384,
  mode: "raw_fragment",
  template_preview: PREVIEWS.raw_fragment,
  params: { batch_size: 16, normalize: true, device: "cpu" },
  count: 20,
  coverage: { fragments_total: 21, embedded: 20, stale: 1, missing: 1 },
  created_at: "",
  updated_at: "2026-10-15T12:00:00+00:00",
};

const JOB: JobInfo = {
  id: "jobE",
  kind: "embed",
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

function routes(runs: EmbeddingRunDTO[] = [RUN]) {
  return {
    "/api/embeddings/preparation-preview": PREVIEWS,
    "/api/models": MODELS,
    "GET /api/projects/p1/embeddings": runs,
    "POST /embeddings/compute": mockResponse(202, JOB),
    "POST /models/download": mockResponse(202, { ...JOB, kind: "model_download" }),
  };
}

function resetStores() {
  useProjectStore.setState({
    current: { id: "p1", name: "Sample" } as never,
    activeJob: null,
    error: null,
  });
  useExperimentStore.setState({
    models: null,
    previews: null,
    runs: null,
    activeJob: null,
    modelId: null,
    mode: "raw_fragment",
    batchSize: 16,
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetStores();
});

afterEach(() => cleanup());

describe("ExperimentsPanel", () => {
  it("renders models with honest download status and honest model description", async () => {
    const { fetchMock } = mockFetch(routes());
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentsPanel />);

    expect(await screen.findAllByText("paraphrase-multilingual-MiniLM-L12-v2")).toBeTruthy();
    expect(screen.getByText("✓ скачана")).toBeTruthy();
    // Not-downloaded model shows a download button with its size.
    expect(screen.getByRole("button", { name: /Скачать \(~90 МБ\)/ })).toBeTruthy();
    // Honest limitation from the catalog.
    expect(screen.getByText(/НЕ специализирована на коде/)).toBeTruthy();
  });

  it("selects the default model and shows the exact template preview", async () => {
    const { fetchMock } = mockFetch(routes());
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentsPanel />);
    await screen.findAllByText("paraphrase-multilingual-MiniLM-L12-v2");

    const checked = document.querySelector(
      'input[name="embedding-model"]:checked',
    ) as HTMLInputElement | null;
    expect(checked).toBeTruthy();

    // Switch to context mode -> preview shows the real template fields.
    fireEvent.click(screen.getByLabelText(/Context-enriched/));
    const previewToggle = screen.getByText("Точный шаблон того, что будет эмбеддиться");
    fireEvent.click(previewToggle);
    expect(
      await screen.findByText((_, el) => el?.textContent === PREVIEWS.context_enriched),
    ).toBeTruthy();
  });

  it("starts a compute job with the selected form", async () => {
    const { fetchMock, calls } = mockFetch(routes());
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentsPanel />);
    await screen.findAllByText("paraphrase-multilingual-MiniLM-L12-v2");

    fireEvent.click(screen.getByRole("button", { name: "Рассчитать эмбеддинги" }));
    await waitFor(() => {
      expect(useExperimentStore.getState().activeJob?.id).toBe("jobE");
    });
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/compute"));
    expect(post?.body).toEqual({
      model_id: MODELS[0].model_id,
      mode: "raw_fragment",
      batch_size: 16,
    });
  });

  it("runs table shows coverage with stale/missing breakdown", async () => {
    const { fetchMock } = mockFetch(routes());
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentsPanel />);

    expect(await screen.findByText("20/21")).toBeTruthy();
    expect(screen.getByText(/пропущено 1, устарело 1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Пересчитать" })).toBeTruthy();
  });

  it("runs table flags truncated vectors", async () => {
    const truncatedRun: EmbeddingRunDTO = {
      ...RUN,
      truncated_count: 7,
      params: { ...RUN.params, max_seq_length: 128 },
    };
    const { fetchMock } = mockFetch(routes([truncatedRun]));
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentsPanel />);

    const badge = await screen.findByText("усечено 7");
    expect(badge.className).toContain("badge--warn");
    expect(badge.getAttribute("title")).toContain("УСЕЧЁННОГО");
    expect(badge.getAttribute("title")).toContain("128");
  });

  it("runs table shows no truncation badge when count is zero", async () => {
    const { fetchMock } = mockFetch(routes([{ ...RUN, truncated_count: 0 }]));
    vi.stubGlobal("fetch", fetchMock);
    render(<ExperimentsPanel />);

    expect(await screen.findByText("20/21")).toBeTruthy();
    expect(screen.queryByText(/усечено/)).toBeNull();
  });

  it("asks to open a project when none is active", () => {
    useProjectStore.setState({ current: null });
    render(<ExperimentsPanel />);
    expect(screen.getByText(/Откройте проект/)).toBeTruthy();
  });
});
