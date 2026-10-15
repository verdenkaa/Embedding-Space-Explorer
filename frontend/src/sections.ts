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
    stage: 3,
    description: "3D embedding-пространство и синхронная 2D-проекция — появятся на этапе 3.",
  },
  {
    id: "corpus",
    label: "CORPUS",
    stage: 1,
    description: "Дерево файлов, фрагменты и просмотр исходника — появятся на этапе 1.",
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
    stage: 5,
    description: "Сохранённые эксперименты, метрики и экспорт — появятся на этапе 5.",
  },
];
