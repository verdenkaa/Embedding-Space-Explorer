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
    id: "corpus",
    label: "CORPUS",
    stage: null,
    description: "Дерево файлов, фрагменты и просмотр исходника.",
  },
  {
    id: "space",
    label: "SPACE",
    stage: null,
    description:
      "3D embedding-пространство и синхронная 2D-проекция реальных векторов. " +
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
      "Эмбеддинги и проекции: модель, режим подготовки текста, расчёт, " +
      "покрытие, методы проекции. Метрики и экспорт — этап 5.",
  },
];
