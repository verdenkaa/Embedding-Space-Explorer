/**
 * Cluster coloring of the scenes (TZ §8.1): deterministic palette + TEXT
 * legend keys («кластер N» / «шум» / «без метки») — color is never the only
 * identifier, and clusters are never renamed to "topics".
 */

import { COLORS, clusterColor } from "./palette";
import type { PointColorOf } from "../components/space/PointScene";

export const CLUSTER_NOISE_KEY = "шум";
export const CLUSTER_MISSING_KEY = "без метки";

export function clusterLabelKey(label: number | undefined): string {
  if (label === undefined) return CLUSTER_MISSING_KEY;
  return label < 0 ? CLUSTER_NOISE_KEY : `кластер ${label}`;
}

/** Color resolver for a labels map (fragmentId → DBSCAN label). */
export function makeClusterColorOf(labels: Map<string, number>): PointColorOf {
  return (meta) => {
    const label = labels.get(meta.fragmentId);
    const key = clusterLabelKey(label);
    const color =
      label === undefined ? COLORS.gray : label < 0 ? clusterColor(-1) : clusterColor(label);
    return { key, color };
  };
}
