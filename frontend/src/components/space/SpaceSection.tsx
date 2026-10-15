import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { useEffect } from "react";

import { useExperimentStore } from "../../state/experimentStore";
import { useProjectStore } from "../../state/projectStore";
import { useSpaceStore, pickActiveProjections } from "../../state/spaceStore";
import { CorpusPanel } from "../corpus/CorpusPanel";
import { JobPoller } from "../corpus/JobProgress";
import { SourceInspector } from "../inspector/SourceInspector";
import { Projection2D } from "./Projection2D";
import { ExperimentJobPoller, ProjectionControls } from "./ProjectionControls";
import { Scene3D } from "./Scene3D";

/**
 * SPACE section: the full research-IDE layout of TZ §4.2 —
 * corpus panel (left), 3D scene on top / projection controls / synchronized
 * 2D map (center), Monaco source inspector (right). All panels resizable;
 * every view shares the selection state by fragment id (TZ §4.4), so picking
 * a point opens its file and line range in the inspector (scenario B).
 */
export function SpaceSection() {
  const projectId = useProjectStore((s) => s.current?.id ?? null);
  const error = useProjectStore((s) => s.error);

  const runs = useExperimentStore((s) => s.runs);
  const projections = useExperimentStore((s) => s.projections);
  const projRunId = useExperimentStore((s) => s.projRunId);
  const activeJob = useExperimentStore((s) => s.activeJob);
  const loadRuns = useExperimentStore((s) => s.loadRuns);
  const loadProjections = useExperimentStore((s) => s.loadProjections);
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
  }, [projectId, reset, loadRuns, loadProjections]);

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
          <Allotment vertical>
            <Allotment.Pane minSize={180}>
              <Scene3D />
            </Allotment.Pane>
            <Allotment.Pane preferredSize={104} minSize={84} maxSize={240}>
              <ProjectionControls />
            </Allotment.Pane>
            <Allotment.Pane minSize={150}>
              <Projection2D />
            </Allotment.Pane>
          </Allotment>
        </Allotment.Pane>
        <Allotment.Pane preferredSize={440} minSize={300}>
          <SourceInspector />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}
