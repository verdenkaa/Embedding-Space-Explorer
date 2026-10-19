/**
 * Pure formatting helpers for saved experiments: the summary chips
 * of the list view and the side-by-side comparison rows. Kept out of the
 * component for unit tests; every value shown is either served data or an
 * explicit «—» (never an invention).
 */

import type { ExperimentConfigDTO, ExperimentDTO } from "../api/types";

/** Short id for display (full ids live in titles/exports). */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 6) : "—";
}

function metricValuesOf(summary: Record<string, unknown>): Record<string, number | null> {
  const raw = summary["metric_values"];
  return raw && typeof raw === "object" ? (raw as Record<string, number | null>) : {};
}

/** Display chips of the list summary (backend-built at save time). */
export function formatExperimentSummary(summary: Record<string, unknown>): string[] {
  const chips: string[] = [];
  const viewMode = summary["view_mode"];
  if (typeof viewMode === "string") chips.push(`вид: ${viewMode}`);
  const projections = summary["projections"];
  if (projections && typeof projections === "object") {
    const p = projections as { three?: string | null; four?: string | null; two_count?: number };
    const parts: string[] = [];
    if (p.three) parts.push(`3D ${shortId(p.three)}`);
    if (p.two_count) parts.push(`2D ×${p.two_count}`);
    if (p.four) parts.push(`4D ${shortId(p.four)}`);
    chips.push(parts.length > 0 ? `проекции: ${parts.join(", ")}` : "проекции: —");
  }
  if (summary["slice"] === true) chips.push("срез: да");
  const clustering = summary["clustering_run_id"];
  if (typeof clustering === "string" && clustering) chips.push(`кластеры: ${shortId(clustering)}`);
  const groups = summary["groups"];
  if (typeof groups === "number" && groups > 0) chips.push(`группы: ${groups}`);
  const selection = summary["selection"];
  if (typeof selection === "number" && selection > 0) chips.push(`выделение: ${selection}`);
  const values = metricValuesOf(summary);
  for (const [name, value] of Object.entries(values)) {
    chips.push(`${name}: ${value === null ? "нет данных" : value.toFixed(3)}`);
  }
  return chips;
}

function sliceLabel(cfg: ExperimentConfigDTO): string {
  const slice = cfg.slice;
  if (!slice) return "—";
  if (slice.saved_slice_id) {
    return `сохранённый ${shortId(slice.saved_slice_id)} · pos ${fmtNum(slice.position)} · t ${fmtNum(slice.thickness)}`;
  }
  const normal =
    slice.normal_kind === "vector"
      ? `вектор [${(slice.normal_vector ?? []).slice(0, 3).map(fmtNum).join(", ")}…]`
      : `${slice.normal_kind ?? "?"} ${slice.normal_index ?? "?"}`;
  return `${normal} · pos ${fmtNum(slice.position)} · t ${fmtNum(slice.thickness)}`;
}

function fmtNum(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(3) : "—";
}

export interface ComparisonRow {
  label: string;
  a: string;
  b: string;
}

/** Side-by-side comparison of two experiments (configs + save-time context). */
export function buildComparisonRows(a: ExperimentDTO, b: ExperimentDTO): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const push = (label: string, fa: (e: ExperimentDTO) => string) =>
    rows.push({ label, a: fa(a), b: fa(b) });

  push("Сохранён", (e) => e.snapshot["saved_at"]?.toString() ?? e.created_at);
  push("Версия приложения", (e) => e.snapshot["app_version"]?.toString() ?? "—");
  push("Схема БД", (e) => e.snapshot["schema_version"]?.toString() ?? "—");
  push("Вид", (e) => e.config.view_mode);
  push("Эмбеддинги", (e) => shortId(e.config.embedding_run_id));
  push("3D-проекция", (e) => shortId(e.config.projections.three));
  push(
    "2D-проекции",
    (e) =>
      (e.config.projections.two ?? []).length > 0
        ? (e.config.projections.two ?? []).map(shortId).join(", ")
        : "—",
  );
  push("4D-проекция", (e) => shortId(e.config.projections.four));
  push("Срез", (e) => sliceLabel(e.config));
  push("Показ среза", (e) => e.config.slice_display);
  push("Кластеризация", (e) => shortId(e.config.clustering_run_id));
  push("Раскраска", (e) => e.config.color_by);
  push("Группы", (e) => String(e.config.group_ids.length));
  push(
    "Выделение",
    (e) => `${e.config.selection.length}${e.config.selection_truncated ? " (усечено)" : ""}`,
  );

  // corpus at save time
  push("Фрагментов в корпусе (на момент сохранения)", (e) => {
    const corpus = e.snapshot["corpus"];
    if (corpus && typeof corpus === "object") {
      const c = corpus as { fragments?: number; files_indexed?: number };
      return `${c.fragments ?? "—"} (файлов: ${c.files_indexed ?? "—"})`;
    }
    return "—";
  });

  // metric values captured at save time (per run)
  const metricNames = new Set<string>();
  const valuesOf = (e: ExperimentDTO): Record<string, Record<string, number | null>> => {
    const raw = e.snapshot["metric_summary"];
    const out: Record<string, Record<string, number | null>> = {};
    if (raw && typeof raw === "object") {
      for (const [runId, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (entry && typeof entry === "object") {
          const values = (entry as { values?: Record<string, number | null> }).values ?? {};
          out[runId] = values;
          for (const name of Object.keys(values)) metricNames.add(name);
        }
      }
    }
    return out;
  };
  const va = valuesOf(a);
  const vb = valuesOf(b);
  for (const name of [...metricNames].sort()) {
    const fmt = (runs: Record<string, Record<string, number | null>>): string => {
      const parts = Object.entries(runs)
        .map(([runId, values]) => {
          const value = values[name];
          return value === undefined
            ? null
            : `${shortId(runId)}: ${value === null ? "нет" : value.toFixed(3)}`;
        })
        .filter((p): p is string => p !== null);
      return parts.length > 0 ? parts.join("; ") : "—";
    };
    rows.push({ label: `Метрика ${name}`, a: fmt(va), b: fmt(vb) });
  }

  return rows;
}
