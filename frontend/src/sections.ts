/**
 * Top-level application sections shown in the top bar.
 */

export interface SectionDef {
  id: string;
  label: string;
  description: string;
}

export const SECTIONS: SectionDef[] = [
  {
    id: "space",
    label: "SPACE",
    description:
      "3D/2D/4D-представления реальных векторов, дерево файлов и фрагменты, " +
      "соседи, связи и кластеры (левая панель), срез исходного пространства, " +
      "панель метрик качества, экспорт сцен и данных, исходник выбранной " +
      "точки (правая панель).",
  },
  {
    id: "relations",
    label: "RELATIONS",
    description:
      "Структурные связи корпуса: извлечение imports/belongs_to, импорт " +
      "ese-relations/v1, ручные отношения. Семантические соседи — во вкладке " +
      "NEIGHBORS левой панели SPACE.",
  },
  {
    id: "experiments",
    label: "EXPERIMENTS",
    description:
      "Эмбеддинги: модель, режим подготовки текста, расчёт и покрытие. " +
      "Проекции и исследование пространства — раздел SPACE; сохранённые " +
      "эксперименты (снимки состояния) — карточка «Эксперименты» внизу.",
  },
  {
    id: "research",
    label: "RESEARCH",
    description:
      "Исследовательское рабочее пространство проекта: файлы на диске " +
      "(notebooks/, notes/, datasets/, results/, exports/), Jupyter-блокноты " +
      "с доступом к данным проекта, Markdown-заметки с формулами LaTeX и " +
      "экспорт документов (.md / .tex / PDF).",
  },
];
