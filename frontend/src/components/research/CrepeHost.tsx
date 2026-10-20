import { useEffect, useRef, useState } from "react";

import type { Crepe as CrepeType } from "@milkdown/crepe";

import { rewriteDomImages } from "../../markdown/workspaceImages";

/** Inline images are embedded as data: URLs — the workspace API is text-only,
 *  there is no binary upload target. The cap keeps one photo inside the 8 MiB
 *  note save limit (base64 inflates by ~33%). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Honest placeholder instead of a broken blob: the uploader must never
 *  reject (Crepe leaves the "upload in progress" widget stuck on rejection). */
function placeholderImageSvg(message: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="64">` +
    `<rect width="100%" height="100%" fill="#2b2d30" rx="4"/>` +
    `<text x="12" y="38" fill="#e58b8b" font-family="sans-serif" font-size="14">` +
    `${message.replace(/[<>&"]/g, "")}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      resolve(
        placeholderImageSvg(
          `Изображение ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} МБ) больше лимита 4 МБ — ` +
            "вставьте ссылкой или уменьшите файл",
        ),
      );
      return;
    }
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => resolve(typeof reader.result === "string" ? reader.result : placeholderImageSvg("Не удалось прочитать файл")),
      false,
    );
    reader.addEventListener("error", () => resolve(placeholderImageSvg("Не удалось прочитать файл")), false);
    reader.readAsDataURL(file);
  });
}

interface CrepeHostProps {
  /** Markdown at mount time; later edits flow OUT through onChange. */
  initialContent: string;
  /** Serialized markdown after every document change (dirty tracking). */
  onChange: (markdown: string) => void;
  projectId: string;
  /** Workspace path of the note — base for relative image sources. */
  notePath: string;
}

/**
 * Milkdown Crepe WYSIWYG host (TZ §6.2: the prototyped stack — Crepe +
 * frame-dark + KaTeX). The editor is UNCONTROLLED: it mounts once with the
 * initial markdown and reports changes upward; the parent remounts it (key)
 * when the document is replaced on disk. Crepe and its theme CSS are loaded
 * lazily so the heavy ProseMirror/CodeMirror/Vue bundle stays out of the
 * main chunk. LaTeX ($…$ / $$…$$ / "latex" code blocks) renders through the
 * built-in Latex feature (KaTeX — the same katex the app already bundles).
 */
export function CrepeHost({ initialContent, onChange, projectId, notePath }: CrepeHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Captured ONCE per mount: later store updates must not re-run the effect.
  const [initial] = useState(initialContent);
  const onChangeRef = useRef(onChange);
  const imagesRef = useRef({ projectId, notePath });

  useEffect(() => {
    onChangeRef.current = onChange;
    imagesRef.current = { projectId, notePath };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let crepe: CrepeType | null = null;
    let observer: MutationObserver | null = null;

    const rewriteImages = () => {
      const { projectId: pid, notePath: np } = imagesRef.current;
      rewriteDomImages(host, pid, np);
    };

    void (async () => {
      const [crepeModule] = await Promise.all([
        import("@milkdown/crepe"),
        import("@milkdown/crepe/theme/common/style.css"),
        import("@milkdown/crepe/theme/frame-dark.css"),
      ]);
      if (cancelled || !hostRef.current) return;
      const { Crepe, CrepeFeature } = crepeModule;
      crepe = new Crepe({
        root: hostRef.current,
        defaultValue: initial,
        featureConfigs: {
          [CrepeFeature.Placeholder]: {
            text: "Заметка… «/» — вставить блок, $…$ — формула LaTeX",
          },
          [CrepeFeature.Latex]: {
            // Degrade broken formulas instead of failing the document (TZ §6.5).
            katexOptions: { throwOnError: false, strict: "ignore" },
          },
          [CrepeFeature.ImageBlock]: {
            onUpload: fileToDataUrl,
          },
          [CrepeFeature.LinkTooltip]: {
            inputPlaceholder: "Вставьте ссылку…",
          },
          [CrepeFeature.CodeMirror]: {
            searchPlaceholder: "Поиск языка",
            noResultText: "Ничего не найдено",
            previewToggleText: (previewOnlyMode: boolean) =>
              previewOnlyMode ? "Показать код" : "Показать результат",
          },
          [CrepeFeature.BlockEdit]: {
            textGroup: {
              label: "Текст",
              text: { label: "Обычный текст" },
              h1: { label: "Заголовок 1" },
              h2: { label: "Заголовок 2" },
              h3: { label: "Заголовок 3" },
              h4: { label: "Заголовок 4" },
              quote: { label: "Цитата" },
              divider: { label: "Разделитель" },
            },
            listGroup: {
              label: "Списки",
              bulletList: { label: "Маркированный список" },
              orderedList: { label: "Нумерованный список" },
              taskList: { label: "Список задач" },
            },
            advancedGroup: {
              label: "Вставка",
              image: { label: "Изображение" },
              codeBlock: { label: "Блок кода" },
              table: { label: "Таблица" },
              math: { label: "Формула (LaTeX)" },
            },
          },
          [CrepeFeature.Toolbar]: {
            boldLabel: "Жирный",
            italicLabel: "Курсив",
            strikethroughLabel: "Зачёркнутый",
            codeLabel: "Код",
            linkLabel: "Ссылка",
            latexLabel: "Формула LaTeX",
          },
        },
      });
      // NOTE: no destructuring — ListenerManager.markdownUpdated is a
      // prototype method that pushes into `this`; only the arrow properties
      // (updated/blur/…) survive destructuring.
      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => onChangeRef.current(markdown));
      });
      await crepe.create();
      if (cancelled) {
        await crepe.destroy().catch(() => undefined);
        crepe = null;
        return;
      }
      // Relative image sources (plots from results/) → the backend raw route.
      // ProseMirror serializes from node attrs, so DOM-only rewrites never
      // leak into the saved markdown.
      observer = new MutationObserver(rewriteImages);
      observer.observe(host, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src"],
      });
      rewriteImages();
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      observer = null;
      const instance = crepe;
      crepe = null;
      if (instance) void instance.destroy().catch(() => undefined);
      host.innerHTML = "";
    };
    // Mount-once semantics: `initial` is captured via useState and never
    // changes — remounts are driven by the parent's key (path/reloadToken).
  }, [initial]);

  return <div className="note-crepe" ref={hostRef} data-testid="crepe-host" aria-label="Редактор заметки (WYSIWYG)" />;
}
