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
    { token: "comment", foreground: "777E88", fontStyle: "italic" },
    { token: "keyword", foreground: "CF8EAE" },
    { token: "string", foreground: "C9A36A" },
    { token: "string.escape", foreground: "C9A36A" },
    { token: "number", foreground: "B6A0DF" },
    { token: "regexp", foreground: "C9A36A" },
    { token: "type", foreground: "E5B567" },
    { token: "type.identifier", foreground: "E5B567" },
    { token: "function", foreground: "56B6C2" },
    { token: "identifier", foreground: "C9CCD2" },
    { token: "delimiter", foreground: "A4A7AD" },
    { token: "tag", foreground: "58B6D8" },
    { token: "attribute.name", foreground: "E5B567" },
    { token: "attribute.value", foreground: "C9A36A" },
    { token: "annotation", foreground: "B6A0DF" },
    { token: "decorator", foreground: "B6A0DF" },
  ],
  colors: {
    "editor.background": "#1E1F22",
    "editor.foreground": "#C9CCD2",
    "editorLineNumber.foreground": "#626771",
    "editorLineNumber.activeForeground": "#A4A7AD",
    "editorCursor.foreground": "#548AF7",
    "editor.lineHighlightBackground": "#252629",
    "editor.selectionBackground": "#354966",
    "editor.inactiveSelectionBackground": "#2B3441",
    "editorGutter.background": "#1E1F22",
    "editorWidget.background": "#252629",
    "editorWidget.border": "#45474D",
    "scrollbarSlider.background": "#45474D66",
    "scrollbarSlider.hoverBackground": "#45474DAA",
    "editorIndentGuide.background1": "#303237",
    "editorIndentGuide.activeBackground1": "#45474D",
    "focusBorder": "#548AF7",
  },
});
