"""Research workspace: per-project document files (notebooks, notes, exports).

The workspace lives at ``<project_dir>/workspace/`` and is intentionally
separate from the source corpus (which is scanned from the manifest roots):
research documents never become part of the embedding corpus automatically.
"""

from app.workspace.store import (
    WORKSPACE_DIRNAME,
    WORKSPACE_SUBDIRS,
    WorkspaceBinaryError,
    WorkspaceConflict,
    WorkspaceError,
    WorkspaceExists,
    WorkspaceNotFound,
    WorkspacePathError,
    WorkspaceTooLarge,
    create_path,
    delete_path,
    ensure_workspace,
    list_tree,
    open_in_file_manager,
    read_text,
    rename_path,
    resolve_in_workspace,
    workspace_root,
    write_text,
)

__all__ = [
    "WORKSPACE_DIRNAME",
    "WORKSPACE_SUBDIRS",
    "WorkspaceBinaryError",
    "WorkspaceConflict",
    "WorkspaceError",
    "WorkspaceExists",
    "WorkspaceNotFound",
    "WorkspacePathError",
    "WorkspaceTooLarge",
    "create_path",
    "delete_path",
    "ensure_workspace",
    "list_tree",
    "open_in_file_manager",
    "read_text",
    "rename_path",
    "resolve_in_workspace",
    "workspace_root",
    "write_text",
]
