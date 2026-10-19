import { beforeEach, describe, expect, it, vi } from "vitest";

import * as download from "../api/download";
import { exportScenesPng } from "./sceneCapture";

/**
 * Scene capture: PNG export must grab EXACTLY the canvases on
 * screen for the active view mode — 3D/4D scenes (.point-scene canvas) and
 * 2D plots (.projection2d__canvas-wrap canvas), never both by accident.
 */

function makeRoot(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

const SCENE = '<div class="point-scene"><canvas /></div>';
const PLOT = '<div class="projection2d__canvas-wrap"><canvas /></div>';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(download, "downloadCanvasPng").mockImplementation(() => {});
});

describe("exportScenesPng", () => {
  it("captures the 3D scene in 3d mode and ignores 2D plots", () => {
    const root = makeRoot(SCENE + PLOT);
    const n = exportScenesPng("3d", root);
    expect(n).toBe(1);
    expect(download.downloadCanvasPng).toHaveBeenCalledTimes(1);
    const name = vi.mocked(download.downloadCanvasPng).mock.calls[0][1];
    expect(name).toMatch(/^ese-scene-.*\.png$/);
  });

  it("captures both scene and plots in split mode", () => {
    const root = makeRoot(SCENE + PLOT + PLOT);
    const n = exportScenesPng("split", root);
    expect(n).toBe(3);
    const names = vi.mocked(download.downloadCanvasPng).mock.calls.map((c) => c[1]);
    expect(names.filter((x) => x.startsWith("ese-scene-"))).toHaveLength(1);
    expect(names.filter((x) => x.startsWith("ese-plot2d-"))).toHaveLength(2);
  });

  it("captures only plots in 2d mode", () => {
    const root = makeRoot(SCENE + PLOT);
    const n = exportScenesPng("2d", root);
    expect(n).toBe(1);
    expect(vi.mocked(download.downloadCanvasPng).mock.calls[0][1]).toMatch(/^ese-plot2d-/);
  });

  it("captures the 4D scene in 4d mode", () => {
    const root = makeRoot(SCENE);
    expect(exportScenesPng("4d", root)).toBe(1);
  });

  it("returns 0 when nothing is on screen (no fake files)", () => {
    expect(exportScenesPng("3d", makeRoot(""))).toBe(0);
  });
});
