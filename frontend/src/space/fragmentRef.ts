/**
 * Mapping from served point metadata to the corpus FragmentMeta reference.
 *
 * Only `id` and `file_id` are consumed by projectStore.selectFragment —
 * the full fragment metadata (method, parent symbol, language…) is resolved
 * from the corpus once the file detail loads, so the placeholder fields
 * below never surface in the UI.
 */

import type { FragmentMeta } from "../api/types";
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
