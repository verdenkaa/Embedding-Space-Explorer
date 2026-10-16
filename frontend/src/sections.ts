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
      "3D/2D/4D-представления реальных векторов, дерево файлов и фрагменты " +
      "(левая панель), исходник выбранной точки (правая панель). " +
      "Срезы, соседи и кластеры — этап 4.",
  },
  {
    id: "relations",
    label: "RELATIONS",
    stage: 4,
    description: "Структурные отношения и семантические соседи — появятся на этапе 4.",
  },
  {
    id: "experiments",
    label: "EXPERIMENTS",
    stage: null,
    description:
      "Эмбеддинги: модель, режим подготовки текста, расчёт и покрытие. " +
      "Проекции и исследование пространства — раздел SPACE; метрики и экспорт — этап 5.",
  },
];
