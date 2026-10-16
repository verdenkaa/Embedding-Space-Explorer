import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../api/client";
import type { FragmentMeta } from "../../api/types";
import { ORIGIN_LABELS, relationBadge, relationGlyph } from "../../space/relationLabels";
import { useAnalysisStore } from "../../state/analysisStore";
import { useProjectStore } from "../../state/projectStore";
import { AnalysisJobPoller, AnalysisJobProgress } from "../analysis/NeighborsTab";

/**
 * RELATIONS section (stage 4): the project-wide browser of STRUCTURAL
 * relations — filters by kind/origin, extraction job, ese-relations/v1
 * import with an honest per-row report, manual creation and deletion.
 * Semantic neighbors live in the left panel (NEIGHBORS tab) and are never
 * mixed in here (TZ §7.2).
 */

const KNOWN_KINDS = [
  "imports",
  "calls",
  "belongs_to",
  "tested_by",
  "tests",
  "documents",
  "describes",
  "references",
];

/* ------------------------------------------------------------------ */
/* Fragment picker (search-as-you-type)                                 */
/* ------------------------------------------------------------------ */

function FragmentPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FragmentMeta | null;
  onChange: (fragment: FragmentMeta | null) => void;
}) {
  const current = useProjectStore((s) => s.current);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FragmentMeta[]>([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (!current || query.trim().length === 0) {
      setResults([]);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      void api
        .searchFragments(current.id, { q: query.trim(), limit: 8 })
        .then((response) => setResults(response.items))
        .catch(() => setResults([]));
    }, 250);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [query, current]);

  if (value) {
    return (
      <span className="relations__picked">
        <span className="mono">
          {value.symbol_path || value.name || value.id} · {value.start_line}–{value.end_line}
        </span>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => onChange(null)}
          aria-label={`Сбросить выбор: ${label}`}
        >
          ✕
        </button>
      </span>
    );
  }

  return (
    <span className="relations__picker">
      <input
        type="search"
        className="proj-controls__input mono"
        placeholder={label}
        value={query}
        aria-label={label}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <ul className="relations__picker-results">
          {results.map((fragment) => (
            <li key={fragment.id}>
              <button type="button" onMouseDown={() => onChange(fragment)}>
                <span className="mono">{fragment.symbol_path || fragment.name}</span>
                <span className="mono relations__picker-lines">
                  :{fragment.start_line}–{fragment.end_line}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                              */
/* ------------------------------------------------------------------ */

export function RelationsSection() {
  const current = useProjectStore((s) => s.current);
  const browser = useAnalysisStore((s) => s.browser);
  const browserLoading = useAnalysisStore((s) => s.browserLoading);
  const browserFilters = useAnalysisStore((s) => s.browserFilters);
  const setBrowserFilters = useAnalysisStore((s) => s.setBrowserFilters);
  const loadBrowser = useAnalysisStore((s) => s.loadBrowser);
  const extractRelations = useAnalysisStore((s) => s.extractRelations);
  const importRelations = useAnalysisStore((s) => s.importRelations);
  const lastImportReport = useAnalysisStore((s) => s.lastImportReport);
  const createRelation = useAnalysisStore((s) => s.createRelation);
  const deleteRelation = useAnalysisStore((s) => s.deleteRelation);
  const activeJob = useAnalysisStore((s) => s.activeJob);
  const error = useAnalysisStore((s) => s.error);

  const [source, setSource] = useState<FragmentMeta | null>(null);
  const [target, setTarget] = useState<FragmentMeta | null>(null);
  const [manualKind, setManualKind] = useState("calls");
  const [manualDetail, setManualDetail] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!current) return;
    void loadBrowser();
  }, [current, loadBrowser]);

  const onImportFile = useCallback(
    async (file: File) => {
      try {
        const payload: unknown = JSON.parse(await file.text());
        await importRelations(payload);
      } catch {
        // JSON parse errors surface through the store error below
        useAnalysisStore.setState({
          error: {
            code: "invalid_json",
            message: `Файл «${file.name}» не является корректным JSON.`,
            hint: "Проверьте формат ese-relations/v1 (docs/data-model.md §6.8).",
          },
        });
      }
    },
    [importRelations],
  );

  const jobRunning = activeJob?.state === "queued" || activeJob?.state === "running";
  const total = browser?.total ?? 0;
  const offset = browserFilters.offset;
  const kinds = Object.keys(browser?.counts_by_kind ?? {}).sort();

  if (!current) return null;

  return (
    <div className="relations-section">
      <AnalysisJobPoller />
      <header className="relations-section__header">
        <h1 className="relations-section__title">СТРУКТУРНЫЕ СВЯЗИ</h1>
        <span className="mono">{total} в проекте</span>
        <span className="relations-section__spacer" />
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={() => void extractRelations()}
          disabled={jobRunning}
          title="Пересчитать поверхностные связи корпуса: imports (tree-sitter) и belongs_to"
        >
          Извлечь связи
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          aria-label="Файл импорта связей"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onImportFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="btn btn--small"
          onClick={() => fileInputRef.current?.click()}
          title="Импорт корпуса связей формата ese-relations/v1 (JSON)"
        >
          Импорт JSON…
        </button>
      </header>

      <AnalysisJobProgress />
      {error && (
        <div className="workspace-error" role="alert">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint"> {error.hint}</span>}
        </div>
      )}

      {lastImportReport && (
        <div className="relations-section__report" role="status">
          <b>Импорт:</b> добавлено {lastImportReport.imported}, дубликатов{" "}
          {lastImportReport.duplicates}, не разрешено {lastImportReport.unresolved.length}.
          {lastImportReport.unresolved.length > 0 && (
            <ul className="relations-section__unresolved">
              {lastImportReport.unresolved.slice(0, 12).map((u, i) => (
                <li key={i} className="mono">
                  [{u.index}] {u.kind}: {u.reason}
                </li>
              ))}
              {lastImportReport.unresolved.length > 12 && (
                <li>…ещё {lastImportReport.unresolved.length - 12}</li>
              )}
            </ul>
          )}
          <button
            type="button"
            className="btn btn--small"
            onClick={() => useAnalysisStore.setState({ lastImportReport: null })}
          >
            Скрыть
          </button>
        </div>
      )}

      <div className="relations-section__filters">
        <label className="analysis-pane__field">
          <span>тип</span>
          <select
            className="proj-controls__select mono"
            value={browserFilters.kind}
            aria-label="Фильтр по типу связи"
            onChange={(e) => setBrowserFilters({ kind: e.target.value, offset: 0 })}
          >
            <option value="">все</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind} ({browser?.counts_by_kind[kind]})
              </option>
            ))}
          </select>
        </label>
        <label className="analysis-pane__field">
          <span>источник</span>
          <select
            className="proj-controls__select mono"
            value={browserFilters.origin}
            aria-label="Фильтр по происхождению"
            onChange={(e) => setBrowserFilters({ origin: e.target.value, offset: 0 })}
          >
            <option value="">все</option>
            <option value="extracted">извлечено</option>
            <option value="imported">импорт</option>
            <option value="manual">вручную</option>
          </select>
        </label>

        <span className="relations-section__spacer" />

        {/* manual relation */}
        <FragmentPicker label="источник…" value={source} onChange={setSource} />
        <span className="mono" aria-hidden="true">
          →
        </span>
        <FragmentPicker label="цель…" value={target} onChange={setTarget} />
        <input
          className="proj-controls__input mono relations-section__kind"
          list="relation-kinds"
          value={manualKind}
          aria-label="Тип новой связи"
          maxLength={32}
          onChange={(e) => setManualKind(e.target.value)}
        />
        <datalist id="relation-kinds">
          {KNOWN_KINDS.map((kind) => (
            <option key={kind} value={kind} />
          ))}
        </datalist>
        <input
          className="proj-controls__input relations-section__detail"
          value={manualDetail}
          placeholder="заметка (необязательно)"
          aria-label="Заметка к связи"
          maxLength={512}
          onChange={(e) => setManualDetail(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--small"
          disabled={!source || !target || !manualKind.trim() || source.id === target.id}
          onClick={async () => {
            if (!source || !target) return;
            const ok = await createRelation({
              source_fragment_id: source.id,
              target_fragment_id: target.id,
              kind: manualKind.trim(),
              detail: manualDetail.trim() || null,
            });
            if (ok) {
              setSource(null);
              setTarget(null);
              setManualDetail("");
            }
          }}
          title="Добавить ручную связь между двумя фрагментами"
        >
          Добавить связь
        </button>
      </div>

      <div className="relations-section__table" aria-label="Список связей">
        {browserLoading && <div className="empty-hint">Загрузка…</div>}
        {!browserLoading && total === 0 && (
          <div className="empty-hint empty-hint--accent">
            Связей нет. Нажмите «Извлечь связи» (imports/belongs_to из
            исходников) или импортируйте корпус связей (JSON формата
            ese-relations/v1). Глубокие связи (calls, tested_by) появляются
            из импорта — приложение не выдаёт догадки за факты.
          </div>
        )}
        {browser && browser.items.length > 0 && (
          <table className="relations-table">
            <thead>
              <tr>
                <th>тип</th>
                <th>источник</th>
                <th />
                <th>цель</th>
                <th>происхождение</th>
                <th>увер.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {browser.items.map((rel) => (
                <tr key={rel.id}>
                  <td>
                    <span className="relation-row__glyph mono" aria-hidden="true">
                      {relationGlyph(rel.kind)}
                    </span>{" "}
                    <span className="legend-item__badge mono">{relationBadge(rel.kind)}</span>{" "}
                    <span className="mono relations-table__kind">{rel.kind}</span>
                    {rel.detail && (
                      <span
                        className="mono relations-table__detail"
                        title="Свидетельство из исходника (для imports — модуль import-оператора)"
                      >
                        {rel.detail}
                      </span>
                    )}
                  </td>
                  <td className="mono relations-table__endpoint" title={rel.source.rel_path ?? ""}>
                    {rel.source.symbol_path ?? rel.source.name ?? rel.source.rel_path}
                    {rel.source.start_line !== null && ` :${rel.source.start_line}`}
                  </td>
                  <td className="mono" aria-hidden="true">
                    →
                  </td>
                  <td className="mono relations-table__endpoint" title={rel.target.rel_path ?? ""}>
                    {rel.target.symbol_path ?? rel.target.name ?? rel.target.rel_path}
                    {rel.target.start_line !== null && ` :${rel.target.start_line}`}
                  </td>
                  <td>
                    <span className="badge">{ORIGIN_LABELS[rel.origin] ?? rel.origin}</span>
                  </td>
                  <td className="mono">
                    {rel.origin === "extracted" ? (
                      <span title="Извлечено парсером из исходника — это факт, а не оценка сходства">
                        факт
                      </span>
                    ) : rel.confidence !== null ? (
                      `${Math.round(rel.confidence * 100)}%`
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => void deleteRelation(rel.id)}
                      aria-label={`Удалить связь ${rel.id}`}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="relations-section__pager">
        <button
          type="button"
          className="btn btn--small"
          disabled={offset === 0}
          onClick={() => setBrowserFilters({ offset: Math.max(0, offset - 100) })}
        >
          ←
        </button>
        <span className="mono">
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + 100, total)} из {total}
        </span>
        <button
          type="button"
          className="btn btn--small"
          disabled={offset + 100 >= total}
          onClick={() => setBrowserFilters({ offset: offset + 100 })}
        >
          →
        </button>
      </footer>
    </div>
  );
}
