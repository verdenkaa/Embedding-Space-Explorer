/**
 * ansi → HTML converter tests: colors, resets, 256-color mapping,
 * HTML escaping and passthrough of plain text.
 */

import { describe, expect, it } from "vitest";

import { ansiToHtml, tracebackToHtml } from "./ansi";

const ESC = "\u001b";

describe("ansiToHtml", () => {
  it("passes plain text through escaped", () => {
    expect(ansiToHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("maps basic color codes to classes", () => {
    const html = ansiToHtml(`${ESC}[31mred${ESC}[0m normal`);
    expect(html).toContain('<span class="ansi-red">red</span>');
    expect(html).toContain("normal");
  });

  it("combines bold + color and clears on reset", () => {
    const html = ansiToHtml(`${ESC}[1;33mwarn${ESC}[0mafter`);
    expect(html).toContain("ansi-bold");
    expect(html).toContain("ansi-yellow");
    expect(html).toContain("after");
  });

  it("maps 256-color selects to the basic palette", () => {
    const html = ansiToHtml(`${ESC}[38;5;9mbright-red${ESC}[0m`);
    expect(html).toContain("ansi-bright-red");
  });

  it("escapes HTML inside colored text", () => {
    const html = ansiToHtml(`${ESC}[32m<script>${ESC}[0m`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("tracebackToHtml", () => {
  it("joins traceback lines like Jupyter stores them", () => {
    const html = tracebackToHtml([`${ESC}[0;31m---\n`, `${ESC}[0;31mValueError: x\n`]);
    expect(html).toContain("ValueError: x");
    expect(html).toContain("ansi-red");
  });
});
