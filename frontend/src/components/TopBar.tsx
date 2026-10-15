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
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <BrandMark />
        <span className="topbar__title">EMBEDDING SPACE EXPLORER</span>
        <span className="topbar__project" title="Проект ещё не открыт (этап 1)">
          нет проекта
        </span>
      </div>

      <SectionTabs />

      <div className="topbar__spacer" />

      <span className="badge" title="Все данные обрабатываются локально, телеметрия отсутствует">
        локальный режим
      </span>
      <ConnectionIndicator />
    </header>
  );
}
