import DOMPurify from "dompurify";
import { useEffect, useMemo, useState } from "react";

import type { CellOutput } from "../../api/types";
import { ansiToHtml, tracebackToHtml } from "../../markdown/ansi";
import { renderMarkdown } from "../../markdown/renderMarkdown";

/**
 * Renders nbformat cell outputs. Every output type Jupyter produces is
 * either shown natively (streams, errors, text, HTML, images, SVG, JSON,
 * markdown, latex) or falls back to an honest collapsible dump — unknown
 * MIME types are never dropped (they stay in the .ipynb on save).
 */

/**
 * Plot/image output: a thumbnail (readable, but never full-screen) that
 * opens a lightbox at ORIGINAL size on click; the lightbox closes via the
 * ✕ button, Escape or a backdrop click.
 */
function ImageOutput({ src, alt }: { src: string; alt: string }) {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  return (
    <>
      <img
        className="nb-output__image nb-output__image--thumb"
        src={src}
        alt={alt}
        title="Нажмите, чтобы открыть в полном размере"
        onClick={() => setZoomed(true)}
      />
      {zoomed && (
        <div
          className="nb-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Изображение в полном размере"
          onClick={() => setZoomed(false)}
        >
          <button
            type="button"
            className="nb-lightbox__close"
            title="Закрыть (Esc)"
            aria-label="Закрыть"
            onClick={(e) => {
              e.stopPropagation();
              setZoomed(false);
            }}
          >
            ×
          </button>
          <img
            className="nb-lightbox__image"
            src={src}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function dataOf(output: CellOutput): Record<string, unknown> {
  return asRecord(output.data);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join("");
  return value === undefined || value === null ? "" : String(value);
}

function StreamOutput({ output }: { output: CellOutput }) {
  const name = output.name === "stderr" ? "stderr" : "stdout";
  const html = useMemo(() => ansiToHtml(textOf(output.text)), [output.text]);
  return (
    <pre
      className={`nb-output__stream nb-output__stream--${name}`}
      // ANSI-converted, text escaped by the converter — static, safe markup.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ErrorOutput({ output }: { output: CellOutput }) {
  const ename = textOf(output.ename) || "Error";
  const evalue = textOf(output.evalue);
  const traceback = useMemo(
    () => (Array.isArray(output.traceback) ? (output.traceback as string[]) : []),
    [output.traceback],
  );
  const html = useMemo(() => tracebackToHtml(traceback), [traceback]);
  return (
    <div className="nb-output__error">
      <div className="nb-output__error-head mono">
        {ename}
        {evalue ? `: ${evalue}` : ""}
      </div>
      {traceback.length > 0 && (
        <pre className="nb-output__traceback mono" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function MimeOutput({ output }: { output: CellOutput }) {
  const data = dataOf(output);

  if (typeof data["image/png"] === "string") {
    return <ImageOutput src={`data:image/png;base64,${data["image/png"]}`} alt="результат выполнения (график/изображение)" />;
  }
  if (typeof data["image/jpeg"] === "string") {
    return <ImageOutput src={`data:image/jpeg;base64,${data["image/jpeg"]}`} alt="результат выполнения (изображение)" />;
  }
  if (typeof data["image/svg+xml"] === "string") {
    const svg = DOMPurify.sanitize(data["image/svg+xml"] as string, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
    return <div className="nb-output__svg" dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  if (typeof data["text/html"] === "string") {
    const html = DOMPurify.sanitize(data["text/html"] as string, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
    });
    return <div className="nb-output__html" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (typeof data["text/markdown"] === "string") {
    const html = renderMarkdown(data["text/markdown"] as string);
    return <div className="nb-output__markdown md-preview" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (typeof data["text/latex"] === "string") {
    // Render as display math via the shared KaTeX pipeline ($$…$$ wrapper).
    const html = renderMarkdown(`$$\n${data["text/latex"] as string}\n$$`);
    return <div className="nb-output__markdown md-preview" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (data["application/json"] !== undefined) {
    return (
      <pre className="nb-output__text mono">
        {JSON.stringify(data["application/json"], null, 2)}
      </pre>
    );
  }
  if (typeof data["text/plain"] === "string" || Array.isArray(data["text/plain"])) {
    const html = ansiToHtml(textOf(data["text/plain"]));
    return <pre className="nb-output__text mono" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  // Unknown MIME: show a collapsed honest dump; the data stays in the file.
  const mime = Object.keys(data).join(", ") || "empty";
  return (
    <details className="nb-output__unknown">
      <summary>Неподдерживаемый вывод: {mime} (сохранён в файле)</summary>
      <pre className="mono">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

export function CellOutputs({ outputs }: { outputs: CellOutput[] }) {
  if (outputs.length === 0) return null;
  return (
    <div className="nb-cell__outputs">
      {outputs.map((output, i) => {
        if (output.output_type === "stream") return <StreamOutput key={i} output={output} />;
        if (output.output_type === "error") return <ErrorOutput key={i} output={output} />;
        if (output.output_type === "execute_result" || output.output_type === "display_data") {
          return <MimeOutput key={i} output={output} />;
        }
        return (
          <details key={i} className="nb-output__unknown">
            <summary>Неизвестный тип вывода: {String(output.output_type)} (сохранён в файле)</summary>
            <pre className="mono">{JSON.stringify(output, null, 2)}</pre>
          </details>
        );
      })}
    </div>
  );
}
