/**
 * Markdown → sanitized HTML with LaTeX math (KaTeX).
 *
 * Shared by notebook Markdown cells and the notes editor preview.
 * Pipeline: protect code regions (fenced blocks and inline spans) → extract
 * $$…$$ / $…$ math (KaTeX) → marked → restore math → restore code →
 * DOMPurify. Protecting code first guarantees `$…$` inside code is never
 * treated as math, and escaped dollars (\$) never open a formula. The source
 * LaTeX itself is never modified in the stored document.
 *
 * Security: the final HTML goes through DOMPurify (html + MathML + svg
 * profiles) before injection with dangerouslySetInnerHTML.
 */

import DOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

interface Placeholder {
  token: string;
  html: string;
}

const NUL = "\u0000";

function nextToken(prefix: string, index: number): string {
  return `${NUL}${prefix}${index}${NUL}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "htmlAndMathml",
    });
  } catch {
    // KaTeX could not render: show the source verbatim instead of failing the
    // whole preview (the note must stay savable — TZ §6.5).
    return `<code class="math-error">${escapeHtml(tex)}</code>`;
  }
}

/**
 * Replace protected regions with NUL tokens.
 * Order matters: fenced code → inline code → block math → inline math.
 */
export function protectRegions(source: string): { text: string; regions: Placeholder[] } {
  const regions: Placeholder[] = [];

  const protect = (html: string, prefix: string): string => {
    const token = nextToken(prefix, regions.length);
    regions.push({ token, html });
    return token;
  };

  // 1) Fenced code blocks ```lang\n…``` (keep marked's own rendering).
  let text = source.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const cls = lang.trim() ? ` class="language-${escapeHtml(lang.trim())}"` : "";
    return protect(`<pre><code${cls}>${escapeHtml(code)}</code></pre>`, "C");
  });

  // 2) Inline code `…`.
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    protect(`<code>${escapeHtml(code)}</code>`, "c"),
  );

  // 3) Block math $…$ (multiline); escaped \$ never opens a formula.
  text = text.replace(/(?<!\\)\$\$([\s\S]+?)\$\$/g, (_m, tex: string) =>
    protect(renderKatex(tex, true), "M"),
  );

  // 4) Inline math $…$ (single line, no unescaped $ inside).
  text = text.replace(/(?<!\\)\$([^\n$]+?)\$/g, (_m, tex: string) =>
    protect(renderKatex(tex, false), "m"),
  );

  return { text, regions };
}

function restore(html: string, regions: Placeholder[]): string {
  let result = html;
  for (const { token, html: regionHtml } of regions) {
    // marked may wrap lone tokens in <p>…</p>: unwrap paragraphs around
    // block-level replacements (pre / display math) for correct nesting.
    result = result.replaceAll(`<p>${token}</p>`, regionHtml);
    result = result.replaceAll(token, regionHtml);
  }
  return result;
}

/** Extract $$…$$ and $…$ spans (exported for unit tests). */
export function extractMath(source: string): { text: string; maths: Placeholder[] } {
  const { text, regions } = protectRegions(source);
  return { text, maths: regions.filter((r) => r.token.includes("M") || r.token.includes("m")) };
}

/**
 * Render Markdown with LaTeX math to sanitized HTML.
 * Never throws: malformed pieces degrade to escaped text.
 */
export function renderMarkdown(source: string): string {
  const { text, regions } = protectRegions(source);
  const rawHtml = marked.parse(text, { async: false }) as string;
  const restored = restore(rawHtml, regions);
  return DOMPurify.sanitize(restored, {
    USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
    ADD_ATTR: ["target", "rel"],
  });
}
