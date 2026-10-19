import { useEffect, useMemo, useState } from "react";

const STALENESS_POLL_MS = 30_000;

import type { FragmentMeta } from "../../api/types";
import { useProjectStore } from "../../state/projectStore";
import { ChangesDialog } from "../ChangesDialog";
import { ClustersTab } from "../analysis/ClustersTab";
import { NeighborsTab } from "../analysis/NeighborsTab";
import { RelationsTab } from "../analysis/RelationsTab";
import { JobProgress } from "./JobProgress";
import { FileTree } from "./FileTree";
import { FragmentList } from "./FragmentList";
import { SelectedFragmentCard } from "./SelectedFragmentCard";

/** Left panel tabs. All four are live. */
const PANEL_TABS = [
  { id: "fragments", label: "FRAGMENTS", title: "Дерево файлов, фрагменты и поиск" },
  {
    id: "neighbors",
    label: "NEIGHBORS",
    title: "Ближайшие семантические соседи активного фрагмента (по исходным эмбеддингам)",
  },
  {
    id: "relations",
    label: "RELATIONS",
    title: "Структурные связи активного фрагмента (извлечённые, импортированные, ручные)",
  },
  {
    id: "clusters",
    label: "CLUSTERS",
    title: "Автокластеризация и ручные группы",
  },
] as const;

type PanelTab = (typeof PANEL_TABS)[number]["id"];

export function CorpusPanel() {
  const current = useProjectStore((s) => s.current);
  const files = useProjectStore((s) => s.files);
  const selectedFileId = useProjectStore((s) => s.selectedFileId);
  const fileDetail = useProjectStore((s) => s.fileDetail);
  const activeFragmentId = useProjectStore((s) => s.activeFragmentId);
  const selectedIds = useProjectStore((s) => s.selectedFragmentIds);
  const searchQuery = useProjectStore((s) => s.searchQuery);
  const searchResults = useProjectStore((s) => s.searchResults);
  const changes = useProjectStore((s) => s.changes);
  const changesLoading = useProjectStore((s) => s.changesLoading);
  const staleness = useProjectStore((s) => s.staleness);
  const selectFile = useProjectStore((s) => s.selectFile);
  const selectFragment = useProjectStore((s) => s.selectFragment);
  const setSearchQuery = useProjectStore((s) => s.setSearchQuery);
  const runSearch = useProjectStore((s) => s.runSearch);
  const loadChanges = useProjectStore((s) => s.loadChanges);
  const startIndex = useProjectStore((s) => s.startIndex);
  const checkStaleness = useProjectStore((s) => s.checkStaleness);
  const activeJob = useProjectStore((s) => s.activeJob);
  const cancelActiveJob = useProjectStore((s) => s.cancelActiveJob);

  const [searchInput, setSearchInput] = useState("");
  const [tab, setTab] = useState<PanelTab>("fragments");

  // Background staleness indicator: check on mount, every 30 s, and whenever
  // the window regains focus (user returns from the IDE right after editing).
  // The store skips checks while an indexing job runs.
  useEffect(() => {
    void checkStaleness();
    const timer = setInterval(() => void checkStaleness(), STALENESS_POLL_MS);
    const onFocus = () => void checkStaleness();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkStaleness]);

  // Debounced fragment search (server-side).
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput);
      void runSearch();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, setSearchQuery, runSearch]);

  const searching = searchQuery.trim().length > 0;

  const fileFragments: FragmentMeta[] = useMemo(
    () => fileDetail?.fragments ?? [],
    [fileDetail],
  );

  const searchPaths = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of searchResults?.items ?? []) {
      map[item.id] = item.rel_path;
    }
    return map;
  }, [searchResults]);

  const activeFragment = useMemo(() => {
    if (!activeFragmentId) return null;
    const inFile = fileFragments.find((f) => f.id === activeFragmentId);
    if (inFile) return inFile;
    return searchResults?.items.find((f) => f.id === activeFragmentId) ?? null;
  }, [activeFragmentId, fileFragments, searchResults]);

  if (!current) return null;
  const isEmptyProject = (files?.length ?? 0) === 0;

  return (
    <section className="corpus-panel" aria-label="Корпус проекта">
      <div className="corpus-toolbar">
        <span className="corpus-toolbar__project" title={current.roots.join("\n")}>
          {current.name}
        </span>
        <div className="corpus-toolbar__spacer" />
        <button
          type="button"
          className={`btn btn--small${staleness?.dirty ? " btn--alert" : ""}`}
          onClick={() => void loadChanges()}
          disabled={changesLoading}
          title={
            staleness?.dirty
              ? `Корпус устарел: ${staleness.new_count} новых, ${staleness.modified_count} изменённых, ${staleness.deleted_count} удалённых. Нажмите, чтобы посмотреть и применить.`
              : "Просканировать корни и показать новые/изменённые/удалённые файлы (ничего не меняет)"
          }
          aria-label={
            staleness?.dirty ? "Изменения: требуется переиндексация" : "Изменения"
          }
        >
          {changesLoading ? "Проверка…" : "Изменения"}
          {staleness?.dirty && (
            <span className="btn__alert-badge" aria-hidden="true">
              {staleness.new_count + staleness.modified_count + staleness.deleted_count}
            </span>
          )}
        </button>
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={() => void startIndex()}
          title="Индексировать новые и изменённые файлы (неизменившиеся не пересчитываются)"
        >
          Индексировать
        </button>
      </div>

      <JobProgress job={activeJob} onCancel={() => void cancelActiveJob()} />

      {isEmptyProject && !searching && (
        <div className="empty-hint empty-hint--accent">
          Проект пустой. Нажмите «Индексировать», чтобы просканировать корни,
          разбить файлы на фрагменты и построить дерево.
        </div>
      )}

      <div className="corpus-tabs" role="tablist" aria-label="Панели исследования">
        {PANEL_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === tab}
            className={`corpus-tab${item.id === tab ? " corpus-tab--active" : ""}`}
            title={item.title}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "fragments" && (
        <div className="corpus-search">
          <input
            type="search"
            className="corpus-search__input"
            placeholder="Поиск фрагментов и файлов…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Поиск по фрагментам"
          />
          {searching && searchResults && (
            <span className="corpus-search__count mono">{searchResults.total}</span>
          )}
        </div>
      )}

      {tab === "neighbors" && <NeighborsTab />}
      {tab === "relations" && <RelationsTab />}
      {tab === "clusters" && <ClustersTab />}

      {tab === "fragments" && (
      <div className="corpus-body">
        <div className="corpus-tree">
          <FileTree
            files={files ?? []}
            selectedFileId={selectedFileId}
            query={searchQuery}
            onSelect={(fileId) => void selectFile(fileId)}
          />
        </div>
        <div className="corpus-fragments">
          {searching ? (
            <FragmentList
              fragments={searchResults?.items ?? []}
              activeFragmentId={activeFragmentId}
              selectedIds={selectedIds}
              showPath
              paths={searchPaths}
              onSelect={(fragment) => void selectFragment(fragment)}
              emptyHint={searchResults ? "Ничего не найдено." : "Поиск…"}
            />
          ) : (
            <FragmentList
              fragments={fileFragments}
              activeFragmentId={activeFragmentId}
              selectedIds={selectedIds}
              onSelect={(fragment) => void selectFragment(fragment)}
              emptyHint={
                selectedFileId
                  ? "У этого файла нет структурных фрагментов."
                  : "Выберите файл в дереве — здесь появятся его фрагменты."
              }
            />
          )}
        </div>
        <SelectedFragmentCard fragment={activeFragment} />
      </div>
      )}

      {tab !== "fragments" && tab !== "clusters" && (
        <div className="corpus-analysis-card">
          <SelectedFragmentCard fragment={activeFragment} />
        </div>
      )}

      {changes !== null && <ChangesDialog />}
    </section>
  );
}
