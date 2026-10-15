/** Human-facing labels for projection inventory entries (honest freshness). */

import type { ProjectionRunDTO } from "../api/types";

export function runOptionLabel(run: ProjectionRunDTO): string {
  const stale = run.stale ? " · УСТАРЕЛА" : "";
  const damaged = run.cache_ok ? "" : " · кэш повреждён";
  return `${run.method_display_name} · ${run.n_components}D · ${run.count} точ. · seed ${run.seed}${stale}${damaged}`;
}

/** Short label of the method+params for badges, e.g. "PCA · whiten". */
export function projectionSummary(run: ProjectionRunDTO): string {
  const params = Object.entries(run.params)
    .filter(([, v]) => v !== false && v !== "" && !(typeof v === "number" && Number.isNaN(v)))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return params ? `${run.method_display_name} · ${params}` : run.method_display_name;
}
