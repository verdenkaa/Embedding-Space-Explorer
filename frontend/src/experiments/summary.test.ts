import { describe, expect, it } from "vitest";

import type { ExperimentDTO } from "../api/types";
import { buildComparisonRows, formatExperimentSummary, shortId } from "./summary";

const SUMMARY: Record<string, unknown> = {
  view_mode: "split",
  embedding_run_id: "emb123456789",
  projections: { three: "proj3abcdef", four: null, two_count: 2 },
  slice: true,
  clustering_run_id: "cl1abcdef",
  groups: 2,
  selection: 15,
  metric_runs: 1,
  metric_values: { neighbor_retention: 0.4237, relation_precision: null },
};

function exp(over: Partial<ExperimentDTO> = {}): ExperimentDTO {
  return {
    id: "e1",
    name: "baseline",
    description: null,
    created_at: "2026-10-16T10:00:00+00:00",
    config: {
      view_mode: "split",
      embedding_run_id: "emb123456789",
      projections: { three: "proj3abcdef", two: ["p2a", "p2b"], four: null },
      slice: { saved_slice_id: "sl1", position: 0.1, thickness: 0.5 },
      slice_display: "dim",
      clustering_run_id: "cl1abcdef",
      color_by: "cluster",
      group_ids: ["g1", "g2"],
      selection: ["f1", "f2"],
      selection_truncated: false,
      metric_run_ids: ["m1"],
    },
    snapshot: {
      saved_at: "2026-10-16T10:00:00+00:00",
      app_version: "0.8.0",
      schema_version: 7,
      corpus: { fragments: 21, files_indexed: 7 },
      metric_summary: {
        m1: { k: 10, sample: 500, projection_run_id: "proj3abcdef", values: { neighbor_retention: 0.42 } },
      },
    },
    live_status: null,
    ...over,
  };
}

describe("formatExperimentSummary", () => {
  it("renders view, projections, slice, clustering, groups, selection", () => {
    const chips = formatExperimentSummary(SUMMARY);
    expect(chips).toContain("вид: split");
    expect(chips).toContain("проекции: 3D proj3a, 2D ×2");
    expect(chips).toContain("срез: да");
    expect(chips).toContain("кластеры: cl1abc");
    expect(chips).toContain("группы: 2");
    expect(chips).toContain("выделение: 15");
  });

  it("shows captured metric values; null stays «нет данных» (never 0)", () => {
    const chips = formatExperimentSummary(SUMMARY);
    expect(chips).toContain("neighbor_retention: 0.424");
    expect(chips).toContain("relation_precision: нет данных");
  });

  it("omits empty parts honestly", () => {
    const chips = formatExperimentSummary({
      view_mode: "3d",
      projections: { three: null, four: null, two_count: 0 },
      slice: false,
      groups: 0,
      selection: 0,
      metric_values: {},
    });
    expect(chips).toContain("проекции: —");
    expect(chips.some((c) => c.startsWith("группы"))).toBe(false);
    expect(chips.some((c) => c.startsWith("срез"))).toBe(false);
  });
});

describe("buildComparisonRows", () => {
  it("compares configs, save-time context and captured metrics", () => {
    const b = exp({
      id: "e2",
      name: "umap-run",
      config: { ...exp().config, view_mode: "3d", color_by: "kind", selection_truncated: true, selection: ["f1"] },
      snapshot: {
        ...exp().snapshot,
        app_version: "0.7.0",
        metric_summary: {
          m2: { k: 5, sample: 100, projection_run_id: "pX", values: { neighbor_retention: 0.61 } },
        },
      },
    });
    const rows = buildComparisonRows(exp(), b);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));

    expect(byLabel["Вид"]).toMatchObject({ a: "split", b: "3d" });
    expect(byLabel["Версия приложения"]).toMatchObject({ a: "0.8.0", b: "0.7.0" });
    expect(byLabel["2D-проекции"].a).toBe("p2a, p2b");
    expect(byLabel["Срез"].a).toContain("сохранённый sl1");
    expect(byLabel["Выделение"].b).toBe("1 (усечено)");
    expect(byLabel["Фрагментов в корпусе (на момент сохранения)"].a).toBe("21 (файлов: 7)");

    // metric rows are the UNION of both snapshots, per-run values labeled
    const metricRow = byLabel["Метрика neighbor_retention"];
    expect(metricRow.a).toContain("0.420");
    expect(metricRow.b).toContain("0.610");
    expect(byLabel["Метрика neighbor_retention"].a).toContain(shortId("m1"));
  });

  it("renders missing values as «—», never invents them", () => {
    const bare = exp({
      config: {
        ...exp().config,
        slice: null,
        clustering_run_id: null,
        projections: { three: null, two: [], four: null },
      },
      snapshot: {},
    });
    const rows = buildComparisonRows(bare, bare);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel["Срез"].a).toBe("—");
    expect(byLabel["Кластеризация"].a).toBe("—");
    expect(byLabel["3D-проекция"].a).toBe("—");
    expect(byLabel["Версия приложения"].a).toBe("—");
  });
});
