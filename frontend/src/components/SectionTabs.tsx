import { SECTIONS } from "../sections";
import { useUiStore } from "../state/uiStore";
import type { ActiveSection } from "../state/uiStore";

export function SectionTabs() {
  const activeSection = useUiStore((s) => s.activeSection);
  const setActiveSection = useUiStore((s) => s.setActiveSection);

  return (
    <nav className="section-tabs" aria-label="Разделы приложения">
      {SECTIONS.map((section) => {
        const available = section.stage === null;
        const active = available && section.id === activeSection;
        return (
          <button
            key={section.id}
            type="button"
            className={`section-tab${active ? " section-tab--active" : ""}`}
            disabled={!available}
            title={section.description}
            aria-disabled={!available}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (available) setActiveSection(section.id as ActiveSection);
            }}
          >
            {section.label}
            {section.stage !== null && (
              <span className="section-tab__stage">этап {section.stage}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
