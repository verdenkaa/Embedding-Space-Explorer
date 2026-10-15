import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { useEffect } from "react";

import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore, pickActiveProjections, type ViewMode } from "../../state/spaceStore";
import { useUiStore } from "../../state/uiStore";
import { CorpusPanel } from "../corpus/CorpusPanel";
import { JobPoller } from "../corpus/JobProgress";
import { SourceInspector } from "../inspector/SourceInspector";
import { Projection2D } from "./Projection2D";
import { ExperimentJobPoller, ProjectionControls } from "./ProjectionControls";
import { Scene3D } from "./Scene3D";

/**
 * SPACE section: the research-IDE layout of TZ §4.2, adjusted by user
 * feedback — corpus (left) | view-mode toggle + scenes + projection
 * controls at the BOTTOM (center) | Monaco inspector (right, closable).
 * Every view shares the selection state by fragment id (TZ §4.4).
 */

const VIEW_MODES: { id: ViewMode; label: string; hint: string }[] = [
  { id: "3d", label: "3D", hint: "Только 3D-пространство" },
  { id: "2d", label: "2D", hint: "Только 2D-проекция (на всю высоту)" },
  { id: "split", label: "3D+2D", hint: "Обе сцены одновременно (синхронное выделение)" },
];

export function ViewModeToggle() {
  const viewMode = useSpaceStore((s) => s.viewMode);
  const setViewMode = useSpaceStore((s) => s.setViewMode);
  return (
    <div className="view-mode" role="group" aria-label="Режим представления">
      {VIEW_MODES.map((mode) => (
        <button
          key={mode.id}
          type="button"
          className={`view-mode__btn${viewMode === mode.id ? " view-mode__btn--active" : ""}`}
          onClick={() => setViewMode(mode.id)}
          aria-pressed={viewMode === mode.id}
          title={mode.hint}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

export function SpaceSection() {
  const projectId = useProjectStore((s) => s.current?.id ?? null);
  const error = useProjectStore((s) => s.error);
  const inspectorVisible = useUiStore((s) => s.inspectorVisible);
  const setInspectorVisible = useUiStore((s) => s.setInspectorVisible);

  const runs = useExperimentStore((s) => s.runs);
  const projections = useExperimentStore((s) => s.projections);
  const projRunId = useExperimentStore((s) => s.projRunId);
  const activeJob = useExperimentStore((s) => s.activeJob);
  const loadRuns = useExperimentStore((s) => s.loadRuns);
  const loadProjections = useExperimentStore((s) => s.loadProjections);
  const loadPresets = useExperimentStore((s) => s.loadPresets);
  const viewMode = useSpaceStore((s) => s.viewMode);
  const setActiveProjection = useSpaceStore((s) => s.setActiveProjection);
  const reloadActive = useSpaceStore((s) => s.reloadActive);
  const reset = useSpaceStore((s) => s.reset);

  /* Project switch: drop loaded clouds (they belong to another project)
     and (re)load the data the auto-pick below depends on. */
  useEffect(() => {
    reset();
    if (!projectId) return;
    void loadRuns();
    void loadProjections();
    void loadPresets();
  }, [projectId, reset, loadRuns, loadProjections, loadPresets]);

  /* Auto-select which cached projections the views show: freshest non-stale
     per component count of the active embedding run (stale fallback keeps
     the user oriented, badges tell the truth). */
  useEffect(() => {
    if (!projections) return;
    const effectiveRunId = projRunId ?? runs?.[0]?.id ?? null;
    const picked = pickActiveProjections(projections, effectiveRunId);
    void setActiveProjection("3d", picked.three?.id ?? null);
    void setActiveProjection("2d", picked.two?.id ?? null);
  }, [projections, runs, projRunId, setActiveProjection]);

  /* A finished projection/embedding job may have refreshed caches. */
  const jobState = activeJob?.state;
  const jobKind = activeJob?.kind;
  useEffect(() => {
    if (jobState === "done" && (jobKind === "projection" || jobKind === "embed")) {
      void reloadActive();
    }
  }, [jobState, jobKind, reloadActive]);

  return (
    <div className="space-section">
      <JobPoller />
      <ExperimentJobPoller />
      {error && (
        <div className="workspace-error" role="alert">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
        </div>
      )}
      <Allotment>
        <Allotment.Pane preferredSize={320} minSize={240} maxSize={560}>
          <CorpusPanel />
        </Allotment.Pane>
        <Allotment.Pane minSize={380}>
          <div className="space-center">
            <div className="space-center__topbar">
              <ViewModeToggle />
            </div>
            <Allotment vertical>
              {viewMode !== "2d" && (
                <Allotment.Pane minSize={180}>
                  <Scene3D />
                </Allotment.Pane>
              )}
              {viewMode !== "3d" && (
                <Allotment.Pane minSize={150}>
                  <Projection2D />
                </Allotment.Pane>
              )}
            </Allotment>
            <ProjectionControls />
          </div>
        </Allotment.Pane>
        {inspectorVisible && (
          <Allotment.Pane preferredSize={440} minSize={300}>
            <SourceInspector />
          </Allotment.Pane>
        )}
      </Allotment>
      {!inspectorVisible && (
        <button
          type="button"
          className="inspector-reopen"
          onClick={() => setInspectorVisible(true)}
          aria-label="Открыть инспектор исходного кода"
        >
          <span className="inspector-reopen__label">Исходник</span>
          <span aria-hidden="true">◀</span>
        </button>
      )}
    </div>
  );
}
