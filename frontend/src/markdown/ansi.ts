/**
 * Minimal ANSI SGR → HTML converter for Jupyter tracebacks and colored
 * stream output. Supports the codes ipykernel actually emits (16-color
 * foregrounds, 256-color selects mapped to the basic palette, bold/italic/
 * underline, resets). Text content is HTML-escaped; the produced markup is
 * static and safe by construction.
 */

const BASIC_COLORS: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

/** 256-color index → nearest basic ansi class (0-15 exact, rest approximated). */
function color256Class(index: number, background: boolean): string | null {
  if (background) return null; // backgrounds are dropped: dark theme readability wins
  if (index >= 0 && index <= 15) {
    const map = [
      "ansi-black",
      "ansi-red",
      "ansi-green",
      "ansi-yellow",
      "ansi-blue",
      "ansi-magenta",
      "ansi-cyan",
      "ansi-white",
      "ansi-bright-black",
      "ansi-bright-red",
      "ansi-bright-green",
      "ansi-bright-yellow",
      "ansi-bright-blue",
      "ansi-bright-magenta",
      "ansi-bright-cyan",
      "ansi-bright-white",
    ];
    return map[index];
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface AnsiState {
  classes: Set<string>;
}

function stateToTag(state: AnsiState, buffer: string): string {
  if (state.classes.size === 0) return escapeHtml(buffer);
  const cls = [...state.classes].sort().join(" ");
  return `<span class="${cls}">${escapeHtml(buffer)}</span>`;
}

/** Convert a string with ANSI escapes to sanitized static HTML. */
export function ansiToHtml(input: string): string {
  if (!input.includes("\u001b")) return escapeHtml(input);

  const out: string[] = [];
  const state: AnsiState = { classes: new Set() };
  let buffer = "";
  // The ESC control character IS the thing we parse — intentional.
  // eslint-disable-next-line no-control-regex
  const re = /\u001b\[([0-9;]*)m/g;
  let last = 0;
  let match: RegExpExecArray | null;

  const flush = () => {
    if (buffer) {
      out.push(stateToTag(state, buffer));
      buffer = "";
    }
  };

  while ((match = re.exec(input)) !== null) {
    buffer += input.slice(last, match.index);
    flush();
    last = match.index + match[0].length;
    const codes = (match[1] || "0").split(";").map((c) => (c === "" ? 0 : Number(c)));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) {
        state.classes.clear();
      } else if (code === 1) {
        state.classes.add("ansi-bold");
      } else if (code === 3) {
        state.classes.add("ansi-italic");
      } else if (code === 4) {
        state.classes.add("ansi-underline");
      } else if (code === 22) {
        state.classes.delete("ansi-bold");
      } else if (code === 23) {
        state.classes.delete("ansi-italic");
      } else if (code === 24) {
        state.classes.delete("ansi-underline");
      } else if (code === 39) {
        for (const cls of Object.values(BASIC_COLORS)) state.classes.delete(cls);
        for (const name of [
          "ansi-bright-black",
          "ansi-bright-red",
          "ansi-bright-green",
          "ansi-bright-yellow",
          "ansi-bright-blue",
          "ansi-bright-magenta",
          "ansi-bright-cyan",
          "ansi-bright-white",
        ]) {
          state.classes.delete(name);
        }
      } else if (BASIC_COLORS[code]) {
        state.classes.add(BASIC_COLORS[code]);
      } else if (code === 38 || code === 48) {
        // 38;5;n / 38;2;r;g;b
        if (codes[i + 1] === 5) {
          const cls = color256Class(codes[i + 2], code === 48);
          if (cls) state.classes.add(cls);
          i += 2;
        } else if (codes[i + 1] === 2) {
          i += 4; // truecolor: dropped (theme classes only)
        }
      }
    }
  }
  buffer += input.slice(last);
  flush();
  return out.join("");
}

/** Join traceback lines the way Jupyter stores them (each ends with \n). */
export function tracebackToHtml(lines: string[]): string {
  return ansiToHtml(lines.join(""));
}
