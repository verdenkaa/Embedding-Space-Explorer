import { useProjectStore } from "../state/projectStore";
import { useUiStore } from "../state/uiStore";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { SectionTabs } from "./SectionTabs";

export function TopBar() {
  const current = useProjectStore((s) => s.current);
  const activeSection = useUiStore((s) => s.activeSection);
  const setActiveSection = useUiStore((s) => s.setActiveSection);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="topbar__title">Embedding Space Explorer</span>
        <span className="topbar__divider" aria-hidden="true" />
        <span
          className="topbar__project"
          title={current ? current.roots.join("\n") : "Проект не открыт"}
        >
          {current ? current.name : "нет проекта"}
        </span>
      </div>

      <SectionTabs />

      <div className="topbar__spacer" />

      <button
        type="button"
        className={`topbar__diag-btn${activeSection === "diagnostics" ? " topbar__diag-btn--active" : ""}`}
        title="Диагностика backend: версии, проверки, зависимости"
        onClick={() =>
          setActiveSection(activeSection === "diagnostics" ? "space" : "diagnostics")
        }
        aria-pressed={activeSection === "diagnostics"}
      >
        Диагностика
      </button>
      <span className="badge" title="Все данные обрабатываются локально, телеметрия отсутствует">
        локальный режим
      </span>
      <ConnectionIndicator />
    </header>
  );
}
