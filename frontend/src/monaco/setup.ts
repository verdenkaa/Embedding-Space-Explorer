/**
 * Monaco offline setup.
 *
 * Deliberately SLIM: we import the editor core plus only the monarch
 * tokenizers for the languages the corpus viewer shows (python, javascript,
 * typescript, markdown). The heavy language services (TS IntelliSense, JSON/
 * CSS/HTML workers) are NOT bundled: the inspector is read-only, and skipping
 * them keeps the production build small enough for an 8 GB machine.
 *
 * Imported once from main.tsx — components use helpers.ts instead so tests
 * never pull monaco into jsdom.
 */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import editorWorker from "monaco-editor/editor/editor.worker?worker";

// Language tokenizers (monarch) for the corpus languages — no language
// services / workers (monaco-editor 0.57 layout: languages/definitions/<lang>/register).
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/markdown/register";

self.MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker();
  },
};

// Use the bundled monaco instance instead of loading it from a CDN.
loader.config({ monaco });

monaco.editor.defineTheme("ese-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5C6873", fontStyle: "italic" },
    { token: "keyword", foreground: "63A9FF" },
    { token: "string", foreground: "C9A86C" },
    { token: "string.escape", foreground: "E8B45A" },
    { token: "number", foreground: "C9A86C" },
    { token: "regexp", foreground: "C9A86C" },
    { token: "type", foreground: "63A9FF" },
    { token: "type.identifier", foreground: "63A9FF" },
    { token: "function", foreground: "45D6C5" },
    { token: "identifier", foreground: "D7DEE5" },
    { token: "delimiter", foreground: "8A97A3" },
    { token: "tag", foreground: "63A9FF" },
    { token: "attribute.name", foreground: "45D6C5" },
    { token: "attribute.value", foreground: "C9A86C" },
  ],
  colors: {
    "editor.background": "#101316",
    "editor.foreground": "#D7DEE5",
    "editorLineNumber.foreground": "#4A5560",
    "editorLineNumber.activeForeground": "#45D6C5",
    "editorCursor.foreground": "#45D6C5",
    "editor.lineHighlightBackground": "#151A1F",
    "editor.selectionBackground": "#2E3841",
    "editor.inactiveSelectionBackground": "#232A31",
    "editorGutter.background": "#101316",
    "editorWidget.background": "#151A1F",
    "editorWidget.border": "#2E3841",
    "scrollbarSlider.background": "#2E384166",
    "scrollbarSlider.hoverBackground": "#2E3841AA",
    "editorIndentGuide.background1": "#1C2228",
    "editorIndentGuide.activeBackground1": "#2E3841",
    "focusBorder": "#45D6C5",
  },
});
