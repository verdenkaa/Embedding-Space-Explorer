"""Jupyter Notebooks: .ipynb format handling and kernel session management.

Notebooks are STANDARD .ipynb files (nbformat v4) stored in the project's
research workspace — compatible with Jupyter itself, never a private JSON
dialect. Execution happens in one long-lived ipykernel per open notebook
(session), managed by KernelSessionManager (see kernel_manager.py).
"""

from app.notebooks.format import (
    NotebookFormatError,
    new_notebook,
    notebook_from_json,
    notebook_to_json,
    read_notebook_file,
    serialize_notebook,
)

__all__ = [
    "NotebookFormatError",
    "new_notebook",
    "notebook_from_json",
    "notebook_to_json",
    "read_notebook_file",
    "serialize_notebook",
]
