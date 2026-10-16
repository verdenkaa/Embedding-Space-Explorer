/**
 * Display names of the metric set (stage 5). The backend serves the full
 * explanation with every value; these short labels are for compact blocks
 * and tables. Pure module — unit-tested.
 */

export const METRIC_LABELS: Record<string, string> = {
  neighbor_retention: "Сохранение соседей",
  trustworthiness: "Trustworthiness (sklearn)",
  relation_precision: "Согласие с известными связями",
  relation_coverage: "Покрытие известных связей",
};

/** Stable display order: projection quality first, then relation agreement. */
export const METRIC_ORDER = [
  "neighbor_retention",
  "trustworthiness",
  "relation_precision",
  "relation_coverage",
] as const;

export function metricLabel(id: string): string {
  return METRIC_LABELS[id] ?? id;
}

/** Ordered metric ids present in a run (unknown ids appended, sorted). */
export function orderedMetricIds(ids: Iterable<string>): string[] {
  const present = new Set(ids);
  const known = METRIC_ORDER.filter((id) => present.has(id));
  const extra = [...present].filter((id) => !(METRIC_ORDER as readonly string[]).includes(id));
  return [...known, ...extra.sort()];
}

/** Value formatting: null stays a visible "нет данных", never a fake 0. */
export function formatMetricValue(value: number | null): string {
  return value === null ? "нет данных" : value.toFixed(3);
}
