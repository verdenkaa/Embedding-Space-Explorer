/**
 * Client-side scene capture: PNG export saves EXACTLY the pixels
 * currently on screen (WebGL scenes render with preserveDrawingBuffer; 2D
 * plots are plain canvases). The backend never re-renders "screenshots".
 */

import { downloadCanvasPng } from "../api/download";
import type { ViewMode } from "../state/spaceStore";

/** Timestamp suffix for exported image files. */
export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Capture every visible scene/plot canvas as PNG; returns the file count. */
export function exportScenesPng(viewMode: ViewMode, root: ParentNode = document): number {
  let saved = 0;
  if (viewMode !== "2d") {
    root.querySelectorAll<HTMLCanvasElement>(".point-scene canvas").forEach((canvas, i) => {
      downloadCanvasPng(canvas, `ese-scene-${stamp()}${i > 0 ? `-${i + 1}` : ""}.png`);
      saved += 1;
    });
  }
  if (viewMode === "2d" || viewMode === "split") {
    root
      .querySelectorAll<HTMLCanvasElement>(".projection2d__canvas-wrap canvas")
      .forEach((canvas, i) => {
        downloadCanvasPng(canvas, `ese-plot2d-${stamp()}${i > 0 ? `-${i + 1}` : ""}.png`);
        saved += 1;
      });
  }
  return saved;
}
