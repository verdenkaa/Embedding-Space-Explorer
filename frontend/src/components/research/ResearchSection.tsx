import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { useEffect } from "react";

import { useProjectStore } from "../../state/projectStore";
import { useResearchStore } from "../../state/researchStore";
import { WorkspacePanel } from "./WorkspacePanel";
import { DocumentHost } from "./DocumentHost";

/**
 * RESEARCH section: the project's research workspace (TZ §3, §11).
 * Left: document tree + file operations (separate from the corpus — research
 * documents are never indexed into embeddings). Right: the open document
 * (notebook / Markdown note editors mount here).
 */
export function ResearchSection() {
  const projectId = useProjectStore((s) => s.current?.id ?? null);
  const error = useResearchStore((s) => s.error);
  const notice = useResearchStore((s) => s.notice);
  const reset = useResearchStore((s) => s.reset);
  const dismissNotice = useResearchStore((s) => s.dismissNotice);

  /* Project switch: the workspace belongs to one project — drop everything
     loaded for the previous one (never write into the wrong workspace). */
  useEffect(() => {
    reset();
  }, [projectId, reset]);

  /* Notices are transient; auto-dismiss so they don't stack up. */
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 4000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  return (
    <div className="research-section">
      {error && (
        <div className="workspace-error" role="alert">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
        </div>
      )}
      {notice && (
        <div className="research-notice" role="status" onClick={dismissNotice}>
          {notice}
        </div>
      )}
      <Allotment>
        <Allotment.Pane preferredSize={320} minSize={240} maxSize={560}>
          <WorkspacePanel />
        </Allotment.Pane>
        <Allotment.Pane minSize={380}>
          <DocumentHost />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}
