/**
 * renderMarkdown tests: LaTeX math (inline/block/multiline) survives intact,
 * Markdown structures render, and HTML is sanitized.
 */

import { describe, expect, it } from "vitest";

import { extractMath, renderMarkdown } from "./renderMarkdown";

describe("renderMarkdown", () => {
  it("renders headings, lists and tables", () => {
    const html = renderMarkdown(
      ["# Заголовок", "", "- пункт 1", "- пункт 2", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join(
        "\n",
      ),
    );
    expect(html).toContain("<h1>Заголовок</h1>");
    expect(html).toContain("<li>пункт 1</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders inline math with KaTeX and keeps the source LaTeX", () => {
    const html = renderMarkdown("Связь двух векторов можно оценить через $\\cos(\\theta)$.");
    expect(html).toContain("katex");
    // The original command survives in the KaTeX annotation (MathML source).
    expect(html).toContain("\\cos");
    expect(html).toContain("\\theta");
  });

  it("renders block math ($$…$$) in display mode", () => {
    const source = "$$\n\\operatorname{sim}(x,y)=\n\\frac{x \\cdot y}{\\|x\\|\\|y\\|}\n$$";
    const html = renderMarkdown(source);
    expect(html).toContain("katex-display");
    expect(html).toContain("\\operatorname");
    expect(html).toContain("\\frac");
  });

  it("supports multiline constructs like aligned", () => {
    const source =
      "$$\n\\begin{aligned}\na &= b + c \\\\\nd &= e\n\\end{aligned}\n$$";
    const html = renderMarkdown(source);
    expect(html).toContain("katex");
    expect(html).toContain("aligned");
  });

  it("does not mangle underscores/asterisks inside formulas", () => {
    const html = renderMarkdown("$x_i^2 \\cdot y_{max}$");
    expect(html).toContain("x_i^2");
    expect(html).not.toContain("<em>");
  });

  it("keeps code blocks intact", () => {
    const html = renderMarkdown("```python\nx = $not_math$\n```");
    expect(html).toContain("<code");
    expect(html).toContain("$not_math$");
    expect(html).not.toContain("katex");
  });

  it("sanitizes raw HTML (no scripts/onerror)", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script><img src=x onerror=alert(1)>текст",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror");
    expect(html).toContain("текст");
  });

  it("degrades a broken formula to its source instead of failing", () => {
    // \notarealcommand renders as red source in KaTeX (throwOnError: false).
    const html = renderMarkdown("$\\notarealcommand$");
    expect(html.length).toBeGreaterThan(0);
  });
});

describe("extractMath", () => {
  it("extracts block and inline spans, replacing them with placeholders", () => {
    const { text, maths } = extractMath("до $$a^2$$ после $b_1$ конец");
    expect(maths.length).toBe(2);
    for (const m of maths) {
      expect(text).toContain(m.token);
      expect(m.html).toContain("katex");
    }
    expect(text).not.toContain("$$");
  });

  it("leaves escaped dollars alone", () => {
    const { text, maths } = extractMath("цена: 100 \\$ и 200 \\$");
    expect(maths.length).toBe(0);
    expect(text).toContain("\\$");
  });
});
