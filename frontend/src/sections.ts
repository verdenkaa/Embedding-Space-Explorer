/**
 * Top-level application sections and their delivery stages.
 * Honest UI (TZ §17.2): sections that are not implemented yet are visibly
 * disabled in the top bar and labeled with the stage that delivers them —
 * no fake buttons.
 */

export interface SectionDef {
  id: string;
  label: string;
  stage: number | null; // null = available now
  description: string;
}

export const SECTIONS: SectionDef[] = [
  {
    id: "space",
    label: "SPACE",
    stage: null,
    description:
      "3D/2D/4D-представления реальных векторов, дерево файлов и фрагменты, " +
      "соседи, связи и кластеры (левая панель), срез исходного пространства, " +
      "панель метрик качества, экспорт сцен и данных, исходник выбранной " +
      "точки (правая панель).",
  },
  {
    id: "relations",
    label: "RELATIONS",
    stage: null,
    description:
      "Структурные связи корпуса: извлечение imports/belongs_to, импорт " +
      "ese-relations/v1, ручные отношения. Семантические соседи — во вкладке " +
      "NEIGHBORS левой панели SPACE.",
  },
  {
    id: "experiments",
    label: "EXPERIMENTS",
    stage: null,
    description:
      "Эмбеддинги: модель, режим подготовки текста, расчёт и покрытие. " +
      "Проекции и исследование пространства — раздел SPACE; сохранённые " +
      "эксперименты (снимки состояния) — карточка «Эксперименты» внизу.",
  },
];
