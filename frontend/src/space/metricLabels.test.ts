/**
 * pure-module tests: metric labels/formatting, export URL builders,
 * Content-Disposition filename parsing, scene-capture counting.
 */

import { describe, expect, it } from "vitest";

import {
  METRIC_ORDER,
  formatMetricValue,
  metricLabel,
  orderedMetricIds,
} from "./metricLabels";

describe("metricLabels", () => {
  it("known metrics get Russian display names; unknown fall back to the id", () => {
    expect(metricLabel("neighbor_retention")).toBe("Сохранение соседей");
    expect(metricLabel("trustworthiness")).toContain("sklearn");
    expect(metricLabel("relation_precision")).toContain("известными связями");
    expect(metricLabel("some_future_metric")).toBe("some_future_metric");
  });

  it("orders projection quality first, then relation agreement; unknown appended sorted", () => {
    const ids = ["relation_coverage", "zzz_extra", "neighbor_retention", "aaa_extra"];
    expect(orderedMetricIds(ids)).toEqual([
      "neighbor_retention",
      "relation_coverage",
      "aaa_extra",
      "zzz_extra",
    ]);
    // the declared order itself is stable knowledge (UI tables rely on it)
    expect(METRIC_ORDER[0]).toBe("neighbor_retention");
    expect(METRIC_ORDER[METRIC_ORDER.length - 1]).toBe("relation_coverage");
  });

  it("null formats as «нет данных», never as a fake zero", () => {
    expect(formatMetricValue(null)).toBe("нет данных");
    expect(formatMetricValue(0)).toBe("0.000");
    expect(formatMetricValue(0.4237)).toBe("0.424");
  });
});
