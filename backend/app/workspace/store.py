"""On-disk research workspace of one project.

Layout (created lazily, projects predating the feature get it on first use):

    <project_dir>/workspace/
        notebooks/    .ipynb files (Jupyter format, see app.notebooks)
        notes/        .md research notes
        datasets/     user data for experiments
        results/      outputs of notebook experiments
        exports/      generated .md/.tex/.pdf documents
        latex/        preamble.tex / template.latex / export settings

Design rules (TZ §3, §10):

* The workspace is INSIDE the project directory but OUTSIDE the corpus:
  indexing scans only the manifest roots, so research documents are never
  embedded automatically.
* Every path coming from the client is RELATIVE and validated against the
  workspace root (traversal, absolute paths and symlink escapes rejected);
  the frontend never learns or constructs absolute storage paths.
* Writes are atomic (tmp + os.replace), matching the rest of the app.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.storage.projects_store import ProjectContext

WORKSPACE_DIRNAME = "workspace"

#: Fixed, known subdirectories. `open-folder` accepts ONLY these (never an
#: arbitrary client path) so a system command is never built from user input.
WORKSPACE_SUBDIRS: tuple[str, ...] = (
    "notebooks",
    "notes",
    "datasets",
    "results",
    "exports",
    "latex",
)

#: Same cap as the corpus content endpoint (routes_files._MAX_CONTENT_BYTES).
MAX_TEXT_BYTES = 8 * 1024 * 1024

#: Honest cap for the tree listing; a research workspace is not a mirror of /.
MAX_TREE_ENTRIES = 5_000

#: Filenames never shown in the tree (atomic-write temporaries, VCS noise).
_HIDDEN_PREFIX = "."


class WorkspaceError(Exception):
    """Base class for workspace errors (mapped to ApiError in routes)."""


class WorkspacePathError(WorkspaceError):
    """The client path is not a safe relative path inside the workspace."""


class WorkspaceNotFound(WorkspaceError):
    """The requested file/directory does not exist."""


class WorkspaceExists(WorkspaceError):
    """The target path already exists (create/rename conflict)."""


class WorkspaceBinaryError(WorkspaceError):
    """The file is not valid UTF-8 text; the text API refuses to serve it."""


class WorkspaceTooLarge(WorkspaceError):
    """The file exceeds MAX_TEXT_BYTES."""


class WorkspaceConflict(WorkspaceError):
    """The file on disk changed since the client last saw it."""

    def __init__(self, path: str, disk_mtime: float) -> None:
        super().__init__(f"{path} changed on disk (mtime {disk_mtime})")
        self.path = path
        self.disk_mtime = disk_mtime


@dataclass(frozen=True)
class WorkspaceEntry:
    """One tree row (paths are POSIX-style, relative to the workspace)."""

    path: str
    name: str
    kind: Literal["dir", "file"]
    size: int
    mtime: float


def workspace_root(ctx: ProjectContext) -> Path:
    return ctx.project_dir / WORKSPACE_DIRNAME


def ensure_workspace(ctx: ProjectContext) -> Path:
    """Create the workspace skeleton (idempotent) and return its root."""
    root = workspace_root(ctx)
    for sub in WORKSPACE_SUBDIRS:
        (root / sub).mkdir(parents=True, exist_ok=True)
    return root


def _normalize_rel(rel_path: str) -> str:
    """Normalize a client path to POSIX-relative form or raise."""
    raw = (rel_path or "").strip().replace("\\", "/")
    if not raw:
        raise WorkspacePathError("path must not be empty")
    # Absolute paths are never accepted, not even "normalized" into the
    # workspace: /etc/passwd must be rejected, not re-read as etc/passwd.
    if raw.startswith("/"):
        raise WorkspacePathError("absolute paths are not allowed")
    if len(raw) > 2048:
        raise WorkspacePathError("path is too long")
    # Reject drive letters ("C:/...") and any traversal segment.
    if len(raw) >= 2 and raw[1] == ":":
        raise WorkspacePathError("absolute paths are not allowed")
    parts = raw.split("/")
    if any(part in ("", ".", "..") for part in parts[:-1]) or parts[-1] in ("", ".", ".."):
        raise WorkspacePathError("path must stay inside the workspace")
    if any(part.startswith(_HIDDEN_PREFIX) for part in parts):
        raise WorkspacePathError("hidden paths are not part of the workspace")
    return "/".join(parts)


def resolve_in_workspace(ctx: ProjectContext, rel_path: str) -> Path:
    """Resolve a client path and verify it stays under the workspace root.

    Uses fully-resolved real paths, so symlinked escapes are rejected too.
    The target need not exist (create/rename operations).
    """
    rel = _normalize_rel(rel_path)
    root = workspace_root(ctx).resolve()
    candidate = (root / rel).resolve()
    if candidate == root:
        raise WorkspacePathError("the workspace root itself is not a file target")
    if not candidate.is_relative_to(root):
        raise WorkspacePathError("path escapes the workspace")
    return candidate


def _entry_for(path: Path, root: Path) -> WorkspaceEntry:
    rel = path.relative_to(root).as_posix()
    try:
        stat = path.stat()
        size = stat.st_size
        mtime = stat.st_mtime
    except OSError:
        size, mtime = 0, 0.0
    return WorkspaceEntry(
        path=rel,
        name=path.name,
        kind="dir" if path.is_dir() else "file",
        size=size,
        mtime=mtime,
    )


def list_tree(ctx: ProjectContext) -> tuple[list[WorkspaceEntry], bool]:
    """Recursive listing (dirs and files), truncated at MAX_TREE_ENTRIES.

    Missing workspace (project created before the feature) is not an error:
    the caller ensures it; an unreadable directory is simply skipped.
    """
    root = workspace_root(ctx)
    if not root.exists():
        return [], False
    entries: list[WorkspaceEntry] = []
    truncated = False
    stack: list[Path] = [root]
    while stack:
        current = stack.pop()
        try:
            children = sorted(current.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            continue
        for child in children:
            if child.name.startswith(_HIDDEN_PREFIX):
                continue
            if len(entries) >= MAX_TREE_ENTRIES:
                truncated = True
                break
            entries.append(_entry_for(child, root))
            if child.is_dir():
                stack.append(child)
        if truncated:
            break
    entries.sort(key=lambda e: (e.kind != "dir", *[p.lower() for p in e.path.split("/")]))
    return entries, truncated


def read_text(ctx: ProjectContext, rel_path: str) -> tuple[str, float, int]:
    """Read a UTF-8 text file: (content, mtime, size)."""
    path = resolve_in_workspace(ctx, rel_path)
    if not path.is_file():
        raise WorkspaceNotFound(rel_path)
    size = path.stat().st_size
    if size > MAX_TEXT_BYTES:
        raise WorkspaceTooLarge(rel_path)
    data = path.read_bytes()
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkspaceBinaryError(rel_path) from exc
    return content, path.stat().st_mtime, size


def _write_atomic(path: Path, content: str) -> float:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(content.encode("utf-8"))
    os.replace(tmp, path)
    return path.stat().st_mtime


def create_path(
    ctx: ProjectContext, rel_path: str, *, content: str = "", is_dir: bool = False
) -> WorkspaceEntry:
    """Create a new file (with initial content) or directory."""
    ensure_workspace(ctx)
    path = resolve_in_workspace(ctx, rel_path)
    if path.exists():
        raise WorkspaceExists(rel_path)
    if is_dir:
        path.mkdir(parents=True, exist_ok=False)
    else:
        _write_atomic(path, content)
    return _entry_for(path, workspace_root(ctx))


def write_text(
    ctx: ProjectContext,
    rel_path: str,
    content: str,
    *,
    base_mtime: float | None = None,
    force: bool = False,
) -> float:
    """Save text; optional optimistic-concurrency check against base_mtime.

    The file need not exist yet (first save of a new buffer), but its parent
    directory must be inside the workspace (created automatically).
    """
    ensure_workspace(ctx)
    path = resolve_in_workspace(ctx, rel_path)
    if path.is_dir():
        raise WorkspacePathError(f"{rel_path} is a directory")
    if base_mtime is not None and not force and path.is_file():
        disk_mtime = path.stat().st_mtime
        if abs(disk_mtime - base_mtime) > 1e-6:
            raise WorkspaceConflict(rel_path, disk_mtime)
    if len(content.encode("utf-8")) > MAX_TEXT_BYTES:
        raise WorkspaceTooLarge(rel_path)
    return _write_atomic(path, content)


def rename_path(ctx: ProjectContext, src: str, dst: str) -> WorkspaceEntry:
    """Rename/move a file or directory inside the workspace."""
    ensure_workspace(ctx)
    src_path = resolve_in_workspace(ctx, src)
    dst_path = resolve_in_workspace(ctx, dst)
    if not src_path.exists():
        raise WorkspaceNotFound(src)
    if dst_path.exists():
        raise WorkspaceExists(dst)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    if src_path.is_file():
        os.replace(src_path, dst_path)
    else:
        shutil.move(str(src_path), str(dst_path))
    return _entry_for(dst_path, workspace_root(ctx))


def delete_path(ctx: ProjectContext, rel_path: str, *, confirm: bool = False) -> None:
    """Delete a file; directories require confirm=True (recursive)."""
    path = resolve_in_workspace(ctx, rel_path)
    if not path.exists():
        raise WorkspaceNotFound(rel_path)
    if path.is_dir():
        if not confirm:
            raise WorkspacePathError(
                f"{rel_path} is a directory; repeat with confirm=true to delete recursively"
            )
        shutil.rmtree(path)
    else:
        path.unlink()


def open_in_file_manager(path: Path) -> tuple[bool, str | None]:
    """Open a REAL directory in the OS file manager. (ok, error)."""
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # type: ignore[attr-defined]
            return True, None
        if sys.platform == "darwin":
            cmd = ["open", str(path)]
        else:
            if shutil.which("xdg-open") is None:
                return False, "xdg-open не найден; скопируйте путь и откройте папку вручную"
            cmd = ["xdg-open", str(path)]
        # No shell, arguments passed as a list (TZ §7.7). xdg-open may return
        # non-zero even when the manager opened; verify the process started.
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True, None
    except OSError as exc:
        return False, f"{exc.__class__.__name__}: {exc}"


__all__ = [
    "MAX_TEXT_BYTES",
    "MAX_TREE_ENTRIES",
    "WORKSPACE_DIRNAME",
    "WORKSPACE_SUBDIRS",
    "WorkspaceBinaryError",
    "WorkspaceConflict",
    "WorkspaceEntry",
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
