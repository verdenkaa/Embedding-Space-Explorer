import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { useEffect } from "react";

import { useAnalysisStore } from "../../state/analysisStore";
import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore, pickActiveProjections } from "../../state/spaceStore";
import { useUiStore } from "../../state/uiStore";
import { CorpusPanel } from "../corpus/CorpusPanel";
import { JobPoller } from "../corpus/JobProgress";
import { SourceInspector } from "../inspector/SourceInspector";
import { AnalysisJobPoller } from "../analysis/NeighborsTab";
import { Projection2D } from "./Projection2D";
import { MetricsPanel } from "./MetricsPanel";
import { ExperimentJobPoller, ProjectionControls } from "./ProjectionControls";
import { Scene3D } from "./Scene3D";
import { Scene4D } from "./Scene4D";
import { SliceControls } from "./SliceControls";
import { ViewBar } from "./ViewBar";

/**
 * SPACE section: the research-IDE layout of, adjusted by user
 * feedback — corpus (left) | view bar + scenes + projection controls at
 * the BOTTOM (center) | Monaco inspector (right, closable). Every view
 * shares the selection state by fragment id.
 */

export function SpaceSection() {
  const projectId = useProjectStore((s) => s.current?.id ?? null);
  const error = useProjectStore((s) => s.error);
  const inspectorVisible = useUiStore((s) => s.inspectorVisible);
  const setInspectorVisible = useUiStore((s) => s.setInspectorVisible);

  const runs = useExperimentStore((s) => s.runs);
  const projections = useExperimentStore((s) => s.projections);
  const projRunId = useExperimentStore((s) => s.projRunId);
  const loadRuns = useExperimentStore((s) => s.loadRuns);
  const loadProjections = useExperimentStore((s) => s.loadProjections);
  const loadPresets = useExperimentStore((s) => s.loadPresets);
  const viewMode = useSpaceStore((s) => s.viewMode);
  const dataWarning = useSpaceStore((s) => s.dataWarning);
  const setActiveProjection = useSpaceStore((s) => s.setActiveProjection);
  const reset = useSpaceStore((s) => s.reset);
  const resetAnalysis = useAnalysisStore((s) => s.reset);

  /* Project switch: drop loaded clouds (they belong to another project)
     and (re)load the data the auto-pick below depends on. */
  useEffect(() => {
    reset();
    resetAnalysis();
    if (!projectId) return;
    void loadRuns();
    void loadProjections();
    void loadPresets();
  }, [projectId, reset, resetAnalysis, loadRuns, loadProjections, loadPresets]);

  /* Auto-select which cached projections the views show — but ONLY while a
     view is empty or its projection disappeared (deleted / project switch):
     the freshest non-stale per component count of the active embedding run
     (stale fallback keeps the user oriented, badges tell the truth). A
     manual dropdown choice or a multi-plot 2D set survives inventory
     reloads; a finished build switches the views explicitly (store). */
  useEffect(() => {
    if (!projections) return;
    const s = useSpaceStore.getState();
    const alive = new Set(projections.filter((p) => p.cache_ok).map((p) => p.id));
    const effectiveRunId = projRunId ?? runs?.[0]?.id ?? null;
    const picked = pickActiveProjections(projections, effectiveRunId);

    if (s.cloud3d === null || !alive.has(s.cloud3d.projection.id)) {
      void setActiveProjection("3d", picked.three?.id ?? null);
    }
    const shown2d = s.clouds2d.map((c) => c.projection.id);
    if (shown2d.length === 0 || shown2d.some((id) => !alive.has(id))) {
      void setActiveProjection("2d", picked.two?.id ?? null);
    }
    if (s.cloud4d === null || !alive.has(s.cloud4d.projection.id)) {
      void setActiveProjection("4d", picked.four?.id ?? null);
    }
  }, [projections, runs, projRunId, setActiveProjection]);

  return (
    <div className="space-section">
      <JobPoller />
      <ExperimentJobPoller />
      <AnalysisJobPoller />
      {dataWarning && (
        <div className="workspace-error" role="status">
          <span>{dataWarning}</span>
        </div>
      )}
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
            <ViewBar />
            <Allotment vertical>
              {(viewMode === "3d" || viewMode === "split") && (
                <Allotment.Pane minSize={180}>
                  <Scene3D />
                </Allotment.Pane>
              )}
              {viewMode === "4d" && (
                <Allotment.Pane minSize={180}>
                  <Scene4D />
                </Allotment.Pane>
              )}
              {(viewMode === "2d" || viewMode === "split") && (
                <Allotment.Pane minSize={150}>
                  <Projection2D />
                </Allotment.Pane>
              )}
            </Allotment>
            <SliceControls />
            <MetricsPanel />
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
