import { SECTIONS } from "../sections";

export function SectionTabs() {
  return (
    <nav className="section-tabs" aria-label="Разделы приложения">
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          className="section-tab"
          disabled={section.stage !== null}
          title={section.description}
          aria-disabled={section.stage !== null}
        >
          {section.label}
          {section.stage !== null && (
            <span className="section-tab__stage">этап {section.stage}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
