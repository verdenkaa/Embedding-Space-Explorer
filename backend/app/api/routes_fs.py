"""Directory browser for the root picker (TZ §11 trade-off, documented).

Exposes DIRECTORY NAMES only — never file names or contents. Needed because a
browser cannot reveal local filesystem paths; the backend is loopback-only and
Host/Origin-protected, so exposure is limited to the local user who already
has full filesystem access.
"""

from __future__ import annotations

import os
import string
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Query

from app.api.schemas import FsDirEntry, FsListResponse

router = APIRouter(prefix="/api/fs", tags=["fs"])


def _windows_drives() -> list[FsDirEntry]:
    entries: list[FsDirEntry] = []
    for letter in string.ascii_uppercase:
        candidate = f"{letter}:\\"
        if os.path.exists(candidate):
            entries.append(FsDirEntry(name=f"{letter}:", path=candidate))
    return entries


def _is_hidden(name: str) -> bool:
    return name.startswith(".")


@router.get("/list-dirs", response_model=FsListResponse)
def list_dirs(
    path: Annotated[str | None, Query(max_length=2048)] = None,
) -> FsListResponse:
    # Empty path: drives on Windows, filesystem root elsewhere.
    if not path:
        if os.name == "nt":
            return FsListResponse(path=None, parent=None, entries=_windows_drives(), drives=True)
        path = "/"

    base = Path(path).expanduser()
    if not base.exists() or not base.is_dir():
        return FsListResponse(path=str(base), parent=None, entries=[], drives=False)

    entries: list[FsDirEntry] = []
    try:
        with os.scandir(base) as it:
            for entry in it:
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                if _is_hidden(entry.name):
                    continue
                entries.append(FsDirEntry(name=entry.name, path=str(Path(entry.path))))
    except PermissionError:
        return FsListResponse(path=str(base), parent=_parent_str(base), entries=[], drives=False)

    entries.sort(key=lambda e: e.name.lower())
    return FsListResponse(path=str(base), parent=_parent_str(base), entries=entries, drives=False)


def _parent_str(path: Path) -> str | None:
    parent = path.parent
    if parent == path:
        return None
    return str(parent)
