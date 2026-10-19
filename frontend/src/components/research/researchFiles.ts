/**
 * Pure helpers for research workspace file creation (no React exports here —
 * keeps component files fast-refresh clean).
 */

/** Fixed workspace folders offered in the create dialog. */
export const CREATE_FOLDERS = [
  { id: "notebooks", label: "notebooks/ — блокноты (.ipynb)" },
  { id: "notes", label: "notes/ — заметки (.md)" },
  { id: "datasets", label: "datasets/ — данные экспериментов" },
  { id: "results", label: "results/ — результаты вычислений" },
  { id: "exports", label: "exports/ — экспортированные документы" },
] as const;

export type CreateKind = "notebook" | "note" | "dir" | "file";

export const KIND_DEFAULTS: Record<
  CreateKind,
  { folder: string; ext: string; title: string }
> = {
  notebook: { folder: "notebooks", ext: ".ipynb", title: "Новый блокнот" },
  note: { folder: "notes", ext: ".md", title: "Новая заметка" },
  dir: { folder: "datasets", ext: "", title: "Новая папка" },
  file: { folder: "datasets", ext: "", title: "Новый файл" },
};

/**
 * Minimal valid .ipynb skeleton (standard Jupyter format, nbformat 4.5).
 * The `ese` metadata block records the project for reproducibility (TZ §4.4);
 * it is preserved by the notebook editor on every save.
 */
export function emptyNotebookJson(projectId: string): string {
  return JSON.stringify(
    {
      cells: [],
      metadata: {
        kernelspec: {
          display_name: "Python 3 (ipykernel)",
          language: "python",
          name: "python3",
        },
        language_info: { name: "python", version: "3" },
        ese: { project_id: projectId },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  );
}
