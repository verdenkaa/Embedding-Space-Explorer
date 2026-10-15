import { useProjectStore } from "../state/projectStore";
import { useUiStore } from "../state/uiStore";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { SectionTabs } from "./SectionTabs";

/** Small inline SVG mark: three connected nodes (embedding-space motif). */
function BrandMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
      <g stroke="var(--color-accent)" strokeWidth="1.5" fill="none">
        <path d="M9 20 L16 9 L23 20" />
        <path d="M9 20 L23 20" />
      </g>
      <g fill="var(--color-accent)">
        <circle cx="16" cy="9" r="2.4" />
        <circle cx="9" cy="20" r="2.4" />
        <circle cx="23" cy="20" r="2.4" />
      </g>
      <circle cx="16" cy="16.5" r="1.6" fill="var(--color-accent-amber)" />
    </svg>
  );
}

export function TopBar() {
  const current = useProjectStore((s) => s.current);
  const activeSection = useUiStore((s) => s.activeSection);
  const setActiveSection = useUiStore((s) => s.setActiveSection);

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <BrandMark />
        <span className="topbar__title">EMBEDDING SPACE EXPLORER</span>
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
          setActiveSection(activeSection === "diagnostics" ? "corpus" : "diagnostics")
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
