/**
 * File-type coloring of the scenes: a point takes the color of its file's
 * type (by extension), the same color the file-tree badge and the legend use
 * — one source of truth (space/palette.ts). The legend key is the file-type
 * label, so color is never the only identifier.
 */

import { FILE_TYPE_LABEL, pathColor, pathFileType } from "./palette";
import type { PointColorOf } from "../components/space/PointScene";

/** Color resolver that paints each point by its file's type. */
export function makeFileColorOf(): PointColorOf {
  return (meta) => ({
    key: FILE_TYPE_LABEL[pathFileType(meta.relPath)],
    color: pathColor(meta.relPath),
  });
}
