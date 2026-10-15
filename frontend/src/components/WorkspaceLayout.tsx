import { Allotment } from "allotment";
import "allotment/dist/style.css";

import { useProjectStore } from "../state/projectStore";
import { useUiStore } from "../state/uiStore";
import { CorpusPanel } from "./corpus/CorpusPanel";
import { JobPoller } from "./corpus/JobProgress";
import { SourceInspector } from "./inspector/SourceInspector";

/** Corpus workspace: resizable left panel + Monaco inspector (Allotment). */
export function WorkspaceLayout() {
  const error = useProjectStore((s) => s.error);
  const inspectorVisible = useUiStore((s) => s.inspectorVisible);
  const setInspectorVisible = useUiStore((s) => s.setInspectorVisible);

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
        {inspectorVisible && (
          <Allotment.Pane minSize={360}>
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
