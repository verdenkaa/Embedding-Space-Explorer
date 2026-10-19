/**
 * CellOutputs tests: streams, tracebacks, MIME handling and the image
 * thumbnail → lightbox flow (plots must not flood the screen; a click opens
 * the original size with an explicit close).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { CellOutput } from "../../api/types";
import { CellOutputs } from "./CellOutputs";

afterEach(cleanup);

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function outputs(...items: CellOutput[]) {
  render(<CellOutputs outputs={items} />);
}

describe("CellOutputs", () => {
  it("renders stream output", () => {
    outputs({ output_type: "stream", name: "stdout", text: "hello world\n" });
    expect(screen.getByText(/hello world/)).toBeTruthy();
  });

  it("renders error output with ename and traceback", () => {
    outputs({
      output_type: "error",
      ename: "ZeroDivisionError",
      evalue: "division by zero",
      traceback: ["Traceback line", "ZeroDivisionError: division by zero"],
    });
    // ename+evalue appears in the head AND inside the traceback — both fine.
    expect(screen.getAllByText(/ZeroDivisionError: division by zero/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Traceback line/).length).toBeGreaterThan(0);
  });

  it("renders text/plain execute_result", () => {
    outputs({
      output_type: "execute_result",
      execution_count: 2,
      data: { "text/plain": "42" },
      metadata: {},
    });
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("shows unknown MIME as a collapsed honest dump (data preserved)", () => {
    outputs({
      output_type: "display_data",
      data: { "application/x-custom": "payload" },
      metadata: {},
    });
    expect(screen.getByText(/Неподдерживаемый вывод/)).toBeTruthy();
    // the mime name appears in the summary and in the JSON dump
    expect(screen.getAllByText(/application\/x-custom/).length).toBeGreaterThan(0);
  });

  it("image output is a thumbnail that opens a lightbox and closes via ✕", () => {
    outputs({
      output_type: "display_data",
      data: { "image/png": PNG_1PX },
      metadata: {},
    });

    const thumb = document.querySelector(".nb-output__image--thumb") as HTMLImageElement;
    expect(thumb).toBeTruthy();
    expect(document.querySelector(".nb-lightbox")).toBeNull();

    // click → lightbox with the ORIGINAL image
    fireEvent.click(thumb);
    const lightbox = document.querySelector(".nb-lightbox");
    expect(lightbox).toBeTruthy();
    const full = document.querySelector(".nb-lightbox__image") as HTMLImageElement;
    expect(full.src).toContain(PNG_1PX);

    // ✕ closes it
    fireEvent.click(screen.getByLabelText("Закрыть"));
    expect(document.querySelector(".nb-lightbox")).toBeNull();
  });

  it("lightbox closes on Escape", () => {
    outputs({
      output_type: "display_data",
      data: { "image/png": PNG_1PX },
      metadata: {},
    });
    fireEvent.click(document.querySelector(".nb-output__image--thumb") as Element);
    expect(document.querySelector(".nb-lightbox")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".nb-lightbox")).toBeNull();
  });
});
