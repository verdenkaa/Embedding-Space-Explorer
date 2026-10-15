import { Allotment } from "allotment";

import { useProjectStore } from "../state/projectStore";
import { CorpusPanel } from "./corpus/CorpusPanel";
import { JobPoller } from "./corpus/JobProgress";
import { SourceInspector } from "./inspector/SourceInspector";

/** Corpus workspace: resizable left panel + Monaco inspector (Allotment). */
export function WorkspaceLayout() {
  const error = useProjectStore((s) => s.error);

  return (
    <div className="workspace-layout">
      <JobPoller />
      {error && (
        <div className="workspace-error" role="alert">
          <span>{error.message}</span>
          {error.hint && <span className="workspace-error__hint">{error.hint}</span>}
        </div>
      )}
      <Allotment>
        <Allotment.Pane preferredSize={340} minSize={260} maxSize={620}>
          <CorpusPanel />
        </Allotment.Pane>
        <Allotment.Pane minSize={360}>
          <SourceInspector />
        </Allotment.Pane>
      </Allotment>
    </div>
  );
}
