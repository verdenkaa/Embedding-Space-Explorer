"""File hashing and change classification."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from app.source_registry.scanner import FileCandidate, ScanResult


def hash_file(abs_path: str, chunk_size: int = 1 << 20) -> str | None:
    """SHA-256 of file bytes; None when the file cannot be read."""
    digest = hashlib.sha256()
    try:
        with open(abs_path, "rb") as fh:
            while True:
                chunk = fh.read(chunk_size)
                if not chunk:
                    break
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


@dataclass(frozen=True)
class FileChange:
    root: str
    rel_path: str
    abs_path: str
    size: int
    mtime: float
    language: str | None
    reason: str  # "new" | "content" | "size"


@dataclass(frozen=True)
class ExistingFileInfo:
    id: str
    root: str
    rel_path: str
    abs_path: str
    size: int
    mtime: float
    content_hash: str | None
    status: str


@dataclass
class ChangesPlan:
    new: list[FileChange]
    modified: list[FileChange]
    deleted: list[ExistingFileInfo]
    unchanged_count: int


def classify_changes(
    scan: ScanResult,
    existing: list[ExistingFileInfo],
    *,
    verify_hashes: bool = True,
) -> ChangesPlan:
    """Compare a fresh scan with indexed files.

    Fast path: files whose size AND mtime match the index are considered
    unchanged without re-hashing. Anything suspicious is hashed and compared
    by content, so touch-only changes do not trigger re-fragmentation.

    With `verify_hashes=False` (staleness indicator), suspicious files are
    reported as modified WITHOUT hashing: cheaper, but may over-report on
    touch-only changes (e.g. after git checkout). The authoritative /changes
    report always verifies hashes.
    """
    by_key = {(e.root, e.rel_path): e for e in existing}
    seen_keys: set[tuple[str, str]] = set()

    new: list[FileChange] = []
    modified: list[FileChange] = []
    unchanged = 0

    for cand in scan.candidates:
        key = (cand.root, cand.rel_path)
        seen_keys.add(key)
        prev = by_key.get(key)
        if prev is None or prev.status != "indexed":
            new.append(_change(cand, "new"))
            continue
        if prev.size == cand.size and abs(prev.mtime - cand.mtime) < 1e-9:
            unchanged += 1
            continue
        if prev.size != cand.size:
            modified.append(_change(cand, "size"))
            continue
        if not verify_hashes:
            modified.append(_change(cand, "content"))
            continue
        fresh_hash = hash_file(cand.abs_path)
        if fresh_hash is None or fresh_hash != prev.content_hash:
            modified.append(_change(cand, "content"))
        else:
            unchanged += 1

    deleted = [e for key, e in by_key.items() if key not in seen_keys and e.status == "indexed"]
    deleted.sort(key=lambda e: (e.root, e.rel_path))
    return ChangesPlan(new=new, modified=modified, deleted=deleted, unchanged_count=unchanged)


def _change(cand: FileCandidate, reason: str) -> FileChange:
    return FileChange(
        root=cand.root,
        rel_path=cand.rel_path,
        abs_path=cand.abs_path,
        size=cand.size,
        mtime=cand.mtime,
        language=cand.language,
        reason=reason,
    )


def read_text_safely(abs_path: str) -> tuple[str | None, str | None]:
    """Read and decode a file as UTF-8 (replacement for invalid bytes).

    Returns (text, error). Never raises; error is a human-readable string.
    """
    try:
        data = Path(abs_path).read_bytes()
    except OSError as exc:
        return None, f"cannot read file: {exc.__class__.__name__}"
    try:
        return data.decode("utf-8", errors="replace"), None
    except Exception as exc:  # pragma: no cover - decode with replace cannot fail
        return None, f"cannot decode file: {exc!r}"
