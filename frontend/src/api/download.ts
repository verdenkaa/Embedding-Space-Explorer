/**
 * File-download helpers (stage 5): trigger a browser download from an API
 * endpoint (blob + Content-Disposition filename) or from a live canvas
 * (PNG scene capture — the backend never re-renders "screenshots").
 */

import { ApiError } from "./client";

/** Parse the filename out of a Content-Disposition header (pure, testable). */
export function fileNameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim() || fallback;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** GET/POST an API endpoint and save the response body as a file. */
export async function downloadFromApi(
  url: string,
  fallbackName: string,
  init?: RequestInit,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiError(0, "backend_unreachable", "Локальный backend недоступен.");
  }
  if (!response.ok) {
    let message = `Экспорт завершился с HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // non-JSON error body: keep the default message
    }
    throw new ApiError(response.status, "export_failed", message);
  }
  const filename = fileNameFromDisposition(response.headers.get("Content-Disposition"), fallbackName);
  triggerDownload(await response.blob(), filename);
}

/** Save a canvas (2D or WebGL with preserveDrawingBuffer) as a PNG file. */
export function downloadCanvasPng(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (blob) triggerDownload(blob, filename);
  }, "image/png");
}
