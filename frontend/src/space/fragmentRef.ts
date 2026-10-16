/**
 * Mapping from served point metadata to the corpus FragmentMeta reference.
 *
 * Only `id` and `file_id` are consumed by projectStore.selectFragment —
 * the full fragment metadata (method, parent symbol, language…) is resolved
 * from the corpus once the file detail loads, so the placeholder fields
 * below never surface in the UI.
 */

import type { FragmentMeta, NeighborDTO, RelationEndpointDTO } from "../api/types";
import type { PointMeta } from "../state/spaceStore";

export function toFragmentRef(meta: PointMeta): FragmentMeta {
  return {
    id: meta.fragmentId,
    file_id: meta.fileId,
    kind: meta.kind,
    name: meta.name,
    symbol_path: meta.symbolPath,
    parent_symbol_path: null,
    start_line: meta.startLine,
    end_line: meta.endLine,
    method: "",
    language: "",
    ordinal: 0,
  };
}

/** NeighborDTO → FragmentMeta reference (navigation from the NEIGHBORS tab). */
export function neighborToRef(n: NeighborDTO): FragmentMeta {
  return {
    id: n.fragment_id,
    file_id: n.file_id,
    kind: n.kind,
    name: n.name,
    symbol_path: n.symbol_path,
    parent_symbol_path: null,
    start_line: n.start_line,
    end_line: n.end_line,
    method: "",
    language: "",
    ordinal: 0,
  };
}

/** Relation endpoint → FragmentMeta reference, or null for file-level
 *  endpoints (navigation falls back to selecting the file). */
export function endpointToRef(ep: RelationEndpointDTO): FragmentMeta | null {
  if (ep.fragment_id === null || ep.file_id === null) return null;
  return {
    id: ep.fragment_id,
    file_id: ep.file_id,
    kind: "",
    name: ep.name,
    symbol_path: ep.symbol_path ?? "",
    parent_symbol_path: null,
    start_line: ep.start_line ?? 1,
    end_line: ep.end_line ?? (ep.start_line ?? 1),
    method: "",
    language: "",
    ordinal: 0,
  };
}
