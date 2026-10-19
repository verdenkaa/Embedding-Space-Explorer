"""Reading, validating and writing .ipynb files via nbformat.

Principles (TZ §5.1, §5.5):

* the on-disk format is the standard Jupyter one (nbformat v4); files created
  by Jupyter open here and files saved here open in Jupyter;
* damaged notebooks never crash the app: read returns the parsed structure
  plus a list of validation problems, and the UI decides how to proceed;
* unknown outputs and metadata are PRESERVED on save — the editor round-trips
  what it cannot render instead of destroying it.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import nbformat
from nbformat import NotebookNode
from nbformat.validator import NotebookValidationError

from app import __version__


class NotebookFormatError(ValueError):
    """The file is not a notebook at all (not JSON / no cells / bad version)."""


def new_notebook(project_id: str) -> NotebookNode:
    """A fresh notebook bound to a project (TZ §4.4: reproducible context).

    The `ese` metadata block records the project; the kernel bridge reads
    ESE_PROJECT_ID from the environment, this copy is for humans/tooling and
    for warning when a notebook is opened under a different project.
    """
    nb = nbformat.v4.new_notebook()
    nb.nbformat_minor = 5
    nb.cells = [nbformat.v4.new_code_cell("")]
    nb.metadata["kernelspec"] = {
        "display_name": "Python 3 (ipykernel)",
        "language": "python",
        "name": "python3",
    }
    nb.metadata["language_info"] = {"name": "python"}
    nb.metadata["ese"] = {
        "project_id": project_id,
        "created_with": f"embedding-space-explorer {__version__}",
    }
    return nb


def read_notebook_file(path: Path) -> tuple[NotebookNode, list[str]]:
    """Parse a notebook; returns (nb, problems). Raises only for non-notebooks.

    `problems` collects nbformat validation messages: a file with minor
    schema drift still opens (the UI shows a warning; a save normalizes it),
    while structurally invalid content raises NotebookFormatError.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise NotebookFormatError(f"{path.name}: не текстовый файл UTF-8") from exc
    try:
        nb = nbformat.reads(text, as_version=4)
    except json.JSONDecodeError as exc:
        raise NotebookFormatError(f"{path.name}: некорректный JSON ({exc.msg})") from exc
    except nbformat.reader.NotJSONError as exc:
        raise NotebookFormatError(f"{path.name}: некорректный JSON") from exc
    except Exception as exc:  # reader raises assorted errors on junk
        raise NotebookFormatError(f"{path.name}: не блокнот ({exc})") from exc
    if not isinstance(nb, NotebookNode) or not isinstance(nb.get("cells"), list):
        raise NotebookFormatError(f"{path.name}: нет списка ячеек — это не .ipynb")
    return nb, validate(nb)


def validate(nb: NotebookNode) -> list[str]:
    """nbformat validation problems (empty list = valid)."""
    try:
        nbformat.validate(nb)
    except NotebookValidationError as exc:
        return [str(exc).strip()[:2000]]
    except Exception as exc:  # malformed beyond the validator's own guards
        return [f"{exc.__class__.__name__}: {exc}"]
    return []


def normalize(nb: NotebookNode) -> list[str]:
    """In-place normalization before save; returns remaining problems.

    * every cell gets a stable id (nbformat 4.5 requirement) — missing ids
      are generated, existing ones are never rewritten;
    * markdown/raw cells lose execution artifacts that do not belong to them;
    * source is normalized to a single string (Jupyter accepts both forms).
    Unknown outputs/metadata are untouched: round-trip preserves them.
    """
    seen_ids: set[str] = set()
    for cell in nb.cells:
        cell_id = cell.get("id")
        if not isinstance(cell_id, str) or not cell_id or cell_id in seen_ids:
            cell_id = uuid.uuid4().hex[:8]
            while cell_id in seen_ids:
                cell_id = uuid.uuid4().hex[:8]
            cell["id"] = cell_id
        seen_ids.add(cell_id)
        if isinstance(cell.get("source"), list):
            cell["source"] = "".join(cell["source"])
        if cell.get("cell_type") != "code":
            cell.pop("outputs", None)
            cell.pop("execution_count", None)
    if nb.get("nbformat") != 4:
        nb["nbformat"] = 4
    if int(nb.get("nbformat_minor", 0)) < 5:
        nb["nbformat_minor"] = 5
    return validate(nb)


def notebook_to_json(nb: NotebookNode) -> dict[str, Any]:
    """Notebook as a plain JSON-compatible dict (for API responses)."""
    data: dict[str, Any] = json.loads(json.dumps(nb, default=str))
    return data


def notebook_from_json(data: Any) -> NotebookNode:
    """Validate client JSON minimally and build a NotebookNode.

    Raises NotebookFormatError on structurally invalid payloads; full schema
    validation runs later in normalize() (problems are reported, not fatal —
    the goal is to let the user repair a notebook by saving it).
    """
    if not isinstance(data, dict):
        raise NotebookFormatError("блокнот должен быть JSON-объектом")
    cells = data.get("cells")
    if not isinstance(cells, list):
        raise NotebookFormatError("у блокнота нет списка cells")
    for i, cell in enumerate(cells):
        if not isinstance(cell, dict):
            raise NotebookFormatError(f"ячейка #{i}: не JSON-объект")
        if cell.get("cell_type") not in ("code", "markdown", "raw"):
            raise NotebookFormatError(
                f"ячейка #{i}: cell_type должен быть code|markdown|raw, "
                f"получено {cell.get('cell_type')!r}"
            )
        if not isinstance(cell.get("source", ""), (str, list)):
            raise NotebookFormatError(f"ячейка #{i}: source должен быть строкой или списком строк")
    nb = nbformat.from_dict(data)
    nb.nbformat = 4
    return nb


def serialize_notebook(nb: NotebookNode) -> str:
    """Jupyter-canonical JSON text (sorted keys, indent=1 — like Jupyter)."""
    text: str = nbformat.writes(nb, version=4)
    return text


__all__ = [
    "NotebookFormatError",
    "new_notebook",
    "normalize",
    "notebook_from_json",
    "notebook_to_json",
    "read_notebook_file",
    "serialize_notebook",
    "validate",
]
