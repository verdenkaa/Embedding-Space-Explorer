/**
 * MetricsPanel tests: collapsed by default (secondary to space),
 * compute form → explicit payload, result blocks with explanations and
 * «нет данных» for nulls, staleness badge, warnings, empty-state honesty.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetricRunDTO } from "../../api/types";
import { useAnalysisStore } from "../../state/analysisStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { mockFetch, mockResponse, type RecordedCall } from "../../testUtils";
import { MetricsPanel } from "./MetricsPanel";

const RUN: MetricRunDTO = {
  id: "m1abcdef0123456",
  embedding_run_id: "emb1",
  projection_run_id: null,
  k: 10,
  sample_size: 500,
  seed: 42,
  relation_kinds: null,
  n_vectors: 21,
  metrics: {
    neighbor_retention: {
      value: 0.4237,
      k: 10,
      n_sampled: 21,
      n_sampled_with_relations: null,
      n_known_pairs_embedded: null,
      n_pairs_considered: null,
      explanation: "Средняя доля k ближайших соседей ИСХОДНОГО пространства…",
    },
    relation_precision: {
      value: null,
      k: 10,
      n_sampled: null,
      n_sampled_with_relations: 0,
      n_known_pairs_embedded: 0,
      n_pairs_considered: 0,
      explanation: "Доля топ-k соседей, приходящихся на ИЗВЕСТНЫЕ структурные связи…",
    },
    relation_coverage: {
      value: 0.25,
      baseline: 0.05,
      lift: 5.0,
      k: 10,
      n_sampled: null,
      n_sampled_with_relations: 0,
      n_known_pairs_embedded: 4,
      n_pairs_considered: 8,
      explanation: "Доля НАПРАВЛЕНИЙ известных структурных пар…",
    },
  },
  per_kind: {
    belongs_to: {
      relation_precision: {
        value: 0.4,
        baseline: 0.1,
        lift: 4.0,
        k: 10,
        n_sampled: null,
        n_sampled_with_relations: 6,
        n_known_pairs_embedded: 3,
        n_pairs_considered: 6,
        explanation: "…",
      },
      relation_coverage: {
        value: 0.5,
        baseline: 0.05,
        lift: 10.0,
        k: 10,
        n_sampled: null,
        n_sampled_with_relations: 6,
        n_known_pairs_embedded: 3,
        n_pairs_considered: 6,
        explanation: "…",
      },
    },
  },
  warnings: ["projection metrics skipped: no projection run was given"],
  stale: true,
  versions: { numpy: "2.0.0" },
  created_at: "2026-10-16T10:00:00+00:00",
  updated_at: "2026-10-16T10:00:00+00:00",
};

const JOB = {
  id: "jobM",
  kind: "metrics",
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

beforeEach(() => {
  vi.unstubAllGlobals();
  const { fetchMock, calls } = mockFetch({
    "/api/projects/p1/metrics": [RUN],
    "POST /api/projects/p1/metrics/compute": mockResponse(202, JOB),
  });
  vi.stubGlobal("fetch", fetchMock);
  fetchCalls = calls;
  useProjectStore.setState({ current: { id: "p1", name: "Sample" } as never });
  useAnalysisStore.getState().reset();
  useExperimentStore.setState({
    runs: [{ id: "emb1", model_display_name: "MiniLM", mode: "raw_fragment", dim: 8 }] as never,
    projections: [],
  });
});

afterEach(cleanup);

function expand() {
  fireEvent.click(screen.getByRole("button", { name: /Метрики/ }));
}

describe("MetricsPanel", () => {
  it("is collapsed by default — metrics stay secondary to the space", () => {
    render(<MetricsPanel />);
    expect(screen.queryByLabelText("Проекция для метрик")).toBeNull();
    expect(screen.queryByRole("button", { name: "Посчитать" })).toBeNull();
  });

  it("shows results with explanations, «нет данных» for nulls and a stale badge", async () => {
    render(<MetricsPanel />);
    expand();
    await waitFor(() =>
      expect(useAnalysisStore.getState().metricRuns).not.toBeNull(),
    );

    // the run belongs-line: parameters are always visible with the numbers
    expect(screen.getByText(/k=10, выборка 500, seed 42/)).toBeTruthy();
    expect(screen.getByText("устарел")).toBeTruthy();

    // compact blocks: label + formatted value; null is «нет данных», not 0
    expect(screen.getByText("Сохранение соседей")).toBeTruthy();
    expect(screen.getByText("0.424")).toBeTruthy();
    expect(screen.getByText("Согласие с известными связями")).toBeTruthy();
    expect(screen.getByText("нет данных")).toBeTruthy();

    // explanations are served with every value
    expect(screen.getByText(/Средняя доля k ближайших соседей/)).toBeTruthy();
    // honest warnings
    expect(screen.getByText(/projection metrics skipped/)).toBeTruthy();
  });

  it("shows baseline/lift and the per-kind relation table", async () => {
    render(<MetricsPanel />);
    expand();
    await waitFor(() => expect(useAnalysisStore.getState().metricRuns).not.toBeNull());

    // coverage block carries baseline and lift next to the value
    fireEvent.click(screen.getByText("Покрытие известных связей"));
    expect(screen.getByText(/baseline: 0.0500/)).toBeTruthy();
    expect(screen.getByText(/lift: 5.00×/)).toBeTruthy();
    // directed arcs wording
    expect(screen.getByText(/направлений учтено: 8/)).toBeTruthy();

    // per-kind breakdown is rendered with its own lifts
    expect(screen.getByText(/По видам связей/)).toBeTruthy();
    expect(screen.getByText("belongs_to")).toBeTruthy();
    expect(screen.getByText("10.00×")).toBeTruthy();
  });

  it("computes with the explicit form payload (no hidden defaults)", async () => {
    useAnalysisStore.setState({ metricsForm: { k: 7, sample: 123, seed: 5 } });
    render(<MetricsPanel />);
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Посчитать" }));

    await waitFor(() => expect(useAnalysisStore.getState().activeJob?.id).toBe("jobM"));
    const post = fetchCalls.find((c) => c.url.includes("/metrics/compute"));
    expect(post?.body).toMatchObject({
      embedding_run_id: "emb1",
      projection_run_id: null,
      k: 7,
      sample: 123,
      seed: 5,
    });
    // the metrics job gets its own progress line
    expect(screen.getByText(/в очереди/)).toBeTruthy();
  });

  it("empty state explains what metrics are and the incompleteness rule", async () => {
    const { fetchMock } = mockFetch({ "/api/projects/p1/metrics": [] });
    vi.stubGlobal("fetch", fetchMock);
    render(<MetricsPanel />);
    expand();
    await waitFor(() =>
      expect(screen.getByText(/Отсутствие известной связи не считается доказательством/)).toBeTruthy(),
    );
  });
});
