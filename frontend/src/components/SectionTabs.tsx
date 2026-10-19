import { SECTIONS } from "../sections";
import { useUiStore } from "../state/uiStore";
import type { ActiveSection } from "../state/uiStore";

export function SectionTabs() {
  const activeSection = useUiStore((s) => s.activeSection);
  const setActiveSection = useUiStore((s) => s.setActiveSection);

  return (
    <nav className="section-tabs" aria-label="Разделы приложения">
      {SECTIONS.map((section) => {
        const active = section.id === activeSection;
        return (
          <button
            key={section.id}
            type="button"
            className={`section-tab${active ? " section-tab--active" : ""}`}
            title={section.description}
            aria-current={active ? "page" : undefined}
            onClick={() => setActiveSection(section.id as ActiveSection)}
          >
            {section.label}
          </button>
        );
      })}
    </nav>
  );
}
