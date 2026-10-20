/**
 * workspaceImages: document-relative resolution of image sources and their
 * rewriting to the backend raw endpoint (notes referencing notebook plots).
 */

import { describe, expect, it } from "vitest";

import {
  isRawUrl,
  rawSrcUrl,
  resolveWorkspaceSrc,
  rewriteDomImages,
  rewriteHtmlImages,
} from "./workspaceImages";

describe("resolveWorkspaceSrc", () => {
  it("resolves a sibling file against the document directory", () => {
    expect(resolveWorkspaceSrc("notes/a.md", "img.png")).toBe("notes/img.png");
  });

  it("resolves ../ segments (the notebook-plots scenario)", () => {
    expect(resolveWorkspaceSrc("notes/a.md", "../results/plot.png")).toBe("results/plot.png");
    expect(resolveWorkspaceSrc("notes/deep/a.md", "../../results/p.png")).toBe("results/p.png");
  });

  it("normalizes ./ segments and windows separators", () => {
    expect(resolveWorkspaceSrc("notes/a.md", "./sub/./img.png")).toBe("notes/sub/img.png");
    expect(resolveWorkspaceSrc("notes/a.md", "..\\results\\p.png")).toBe("results/p.png");
  });

  it("keeps the query/hash suffix", () => {
    expect(resolveWorkspaceSrc("notes/a.md", "../results/p.png?v=2#x")).toBe("results/p.png?v=2#x");
  });

  it("never touches absolute URLs and root-relative paths", () => {
    expect(resolveWorkspaceSrc("notes/a.md", "https://example.com/i.png")).toBeNull();
    expect(resolveWorkspaceSrc("notes/a.md", "http://example.com/i.png")).toBeNull();
    expect(resolveWorkspaceSrc("notes/a.md", "data:image/png;base64,AAA")).toBeNull();
    expect(resolveWorkspaceSrc("notes/a.md", "blob:http://x/y")).toBeNull();
    expect(resolveWorkspaceSrc("notes/a.md", "/results/p.png")).toBeNull();
    expect(resolveWorkspaceSrc("notes/a.md", "  ")).toBeNull();
  });

  it("refuses to climb above the workspace root", () => {
    expect(resolveWorkspaceSrc("a.md", "../outside.png")).toBeNull();
    expect(resolveWorkspaceSrc("notes/a.md", "../../outside.png")).toBeNull();
  });
});

describe("rawSrcUrl / isRawUrl", () => {
  it("builds the backend raw URL with an encoded path", () => {
    const url = rawSrcUrl("p1", "results/плот.png");
    expect(url).toBe(`/api/projects/p1/workspace/raw?path=${encodeURIComponent("results/плот.png")}`);
    expect(isRawUrl(url)).toBe(true);
  });

  it("does not mistake other sources for raw URLs", () => {
    expect(isRawUrl("results/p.png")).toBe(false);
    expect(isRawUrl("/api/projects/p1/files/1/content")).toBe(false);
  });
});

describe("rewriteHtmlImages", () => {
  it("rewrites relative img sources and keeps the original in data-ese-src", () => {
    const html =
      '<p>x</p><img src="../results/p.png" alt="plot"><img src="https://e.com/i.png">';
    const out = rewriteHtmlImages(html, "p1", "notes/a.md");
    expect(out).toContain(`src="${rawSrcUrl("p1", "results/p.png")}"`);
    expect(out).toContain('data-ese-src="../results/p.png"');
    expect(out).toContain('src="https://e.com/i.png"');
  });

  it("returns the input untouched when there are no images", () => {
    const html = "<p>no images <code>&lt;img&gt;</code></p>";
    expect(rewriteHtmlImages(html, "p1", "notes/a.md")).toBe(html);
  });

  it("leaves html as is when every source is absolute", () => {
    const html = '<img src="data:image/png;base64,AAA">';
    expect(rewriteHtmlImages(html, "p1", "notes/a.md")).toBe(html);
  });
});

describe("rewriteDomImages", () => {
  it("rewrites relative src in a live DOM, idempotently", () => {
    const root = document.createElement("div");
    root.innerHTML = '<img src="../results/p.png"><img src="https://e.com/i.png">';
    rewriteDomImages(root, "p1", "notes/a.md");
    const imgs = root.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe(rawSrcUrl("p1", "results/p.png"));
    expect(imgs[0].getAttribute("data-ese-src")).toBe("../results/p.png");
    expect(imgs[1].getAttribute("src")).toBe("https://e.com/i.png");
    // A second pass changes nothing (MutationObserver re-entrancy).
    rewriteDomImages(root, "p1", "notes/a.md");
    expect(imgs[0].getAttribute("src")).toBe(rawSrcUrl("p1", "results/p.png"));
    // The editor re-rendered the node from its attrs: the rewrite re-applies.
    imgs[0].setAttribute("src", "../results/p.png");
    rewriteDomImages(root, "p1", "notes/a.md");
    expect(imgs[0].getAttribute("src")).toBe(rawSrcUrl("p1", "results/p.png"));
  });
});
