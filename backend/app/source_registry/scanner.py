"""Safe directory/file scanning (TZ §6.1, §11).

Guarantees:
- never leaves the resolved root via '..' or symlinks (unless explicitly
  allowed per project);
- excludes heavy/service directories, binaries, oversized and secret files by
  default, recording WHY every file was skipped;
- deterministic ordering for reproducible diffs.
"""

from __future__ import annotations

import fnmatch
import os
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from app.fragmentation.base import SplitOptions
from app.fragmentation.registry import language_for_path
from app.source_registry.defaults import (
    BINARY_EXTENSIONS,
    DEFAULT_EXCLUDE_DIRS,
    DEFAULT_SECRET_PATTERNS,
    SKIP_BINARY,
    SKIP_EXCLUDED_DIR,
    SKIP_EXCLUDED_PATTERN,
    SKIP_HIDDEN,
    SKIP_SECRET,
    SKIP_SYMLINK_OUTSIDE,
    SKIP_TOO_LARGE,
    SKIP_UNREADABLE,
)

_BINARY_SNIFF_BYTES = 8192


@dataclass(frozen=True)
class FileCandidate:
    root: str
    rel_path: str  # POSIX-style, relative to root
    abs_path: str  # resolved absolute path used for reading
    size: int
    mtime: float
    language: str | None


@dataclass(frozen=True)
class SkippedFile:
    path: str
    reason: str
    detail: str


@dataclass
class ScanResult:
    candidates: list[FileCandidate] = field(default_factory=list)
    skipped: list[SkippedFile] = field(default_factory=list)
    root_errors: list[str] = field(default_factory=list)
    #: emitted when a secret-like file is included because the user's
    #: include-patterns explicitly asked for it (TZ §11).
    warnings: list[str] = field(default_factory=list)


def _matches_any(name: str, rel_path: str, patterns: list[str] | tuple[str, ...]) -> str | None:
    """Return the first matching pattern against file name or rel path."""
    lowered_name = name.lower()
    lowered_path = rel_path.lower()
    for pattern in patterns:
        p = pattern.lower()
        if fnmatch.fnmatch(lowered_name, p) or fnmatch.fnmatch(lowered_path, p):
            return pattern
    return None


def _looks_binary(abs_path: str) -> bool:
    try:
        with open(abs_path, "rb") as fh:
            chunk = fh.read(_BINARY_SNIFF_BYTES)
    except OSError:
        return False  # unreadable handled separately
    return b"\x00" in chunk


def _is_within(child: Path, parent: Path) -> bool:
    try:
        return child.is_relative_to(parent)
    except ValueError:  # pragma: no cover - different drives on Windows
        return False


class RootResolver:
    """Resolves and validates user-provided roots once per project operation."""

    def __init__(self, roots: list[str], options: SplitOptions) -> None:
        self.options = options
        self.resolved: list[Path] = []
        self.errors: list[str] = []
        for raw in roots:
            path = Path(raw).expanduser()
            resolved = path.resolve()
            if not resolved.exists():
                self.errors.append(f"root does not exist: {raw}")
                continue
            self.resolved.append(resolved)
        # Reject nested roots to avoid double-indexing the same files.
        for i, a in enumerate(self.resolved):
            for j, b in enumerate(self.resolved):
                if i != j and _is_within(b, a):
                    self.errors.append(f"root '{b}' is inside another root '{a}'")


def scan_roots(roots: list[str], options: SplitOptions) -> ScanResult:
    """Scan directory/file roots into indexable candidates + skip report."""
    resolver = RootResolver(roots, options)
    result = ScanResult(root_errors=list(resolver.errors))

    include_patterns = list(options.extra_include_patterns)
    exclude_patterns = list(options.extra_exclude_patterns)

    for root in resolver.resolved:
        root_str = str(root)
        if root.is_file():
            # Single-file root: the "root" for relative paths is its parent,
            # so rel_path stays a plain file name.
            parent = root.parent
            _consider_file(
                root, parent, str(parent), result, options, include_patterns, exclude_patterns
            )
            continue
        _walk_dir(root, root_str, result, options, include_patterns, exclude_patterns)

    result.candidates.sort(key=lambda c: (c.root, c.rel_path))
    result.skipped.sort(key=lambda s: s.path)
    return result


def _walk_dir(
    root: Path,
    root_str: str,
    result: ScanResult,
    options: SplitOptions,
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> None:
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        keep_dirs: list[str] = []
        for d in sorted(dirnames):
            sub = current / d
            if d in DEFAULT_EXCLUDE_DIRS:
                result.skipped.append(
                    SkippedFile(str(sub), SKIP_EXCLUDED_DIR, f"service directory '{d}'")
                )
                continue
            if not options.include_hidden and d.startswith("."):
                result.skipped.append(SkippedFile(str(sub), SKIP_HIDDEN, "hidden directory"))
                continue
            if sub.is_symlink() and not options.allow_symlinks_outside_root:
                target = _safe_resolve(sub)
                if target is None or not _is_within(target, root):
                    result.skipped.append(
                        SkippedFile(
                            str(sub),
                            SKIP_SYMLINK_OUTSIDE,
                            f"symlink to '{target}' leaves the project root",
                        )
                    )
                    continue
            keep_dirs.append(d)
        dirnames[:] = keep_dirs

        for fname in sorted(filenames):
            fpath = current / fname
            _consider_file(
                fpath, root, root_str, result, options, include_patterns, exclude_patterns
            )


def _rel_posix(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def _safe_resolve(path: Path) -> Path | None:
    try:
        return path.resolve()
    except OSError:
        return None


def _consider_file(
    fpath: Path,
    root: Path,
    root_str: str,
    result: ScanResult,
    options: SplitOptions,
    include_patterns: list[str],
    exclude_patterns: list[str],
) -> None:
    fname = fpath.name
    rel = _rel_posix(fpath, root)

    # 1. Explicit user exclude patterns win over everything.
    matched_exclude = _matches_any(fname, rel, exclude_patterns)
    if matched_exclude:
        result.skipped.append(
            SkippedFile(str(fpath), SKIP_EXCLUDED_PATTERN, f"matches '{matched_exclude}'")
        )
        return

    # 2. Secret-like files: excluded by default; explicit include → warning.
    secret_match = _matches_any(fname, rel, DEFAULT_SECRET_PATTERNS)
    explicitly_included = bool(_matches_any(fname, rel, include_patterns))
    if secret_match:
        if not explicitly_included:
            result.skipped.append(
                SkippedFile(
                    str(fpath),
                    SKIP_SECRET,
                    f"matches secret pattern '{secret_match}' (excluded by default)",
                )
            )
            return
        result.warnings.append(f"secret-like file included explicitly via include-patterns: {rel}")

    # 3. Include filter: when the user provided include patterns, only
    #    matching files are indexed.
    if include_patterns and not explicitly_included:
        result.skipped.append(
            SkippedFile(str(fpath), SKIP_EXCLUDED_PATTERN, "include-patterns set, no match")
        )
        return

    # 4. Hidden files (explicit include-patterns override hidden exclusion;
    #    hidden DIRECTORIES still require include_hidden=True).
    if not options.include_hidden and fname.startswith(".") and not explicitly_included:
        result.skipped.append(SkippedFile(str(fpath), SKIP_HIDDEN, "hidden file"))
        return

    # 5. Symlink containment.
    read_path = fpath
    if fpath.is_symlink():
        target = _safe_resolve(fpath)
        if target is None or (
            not options.allow_symlinks_outside_root and not _is_within(target, root)
        ):
            result.skipped.append(
                SkippedFile(
                    str(fpath),
                    SKIP_SYMLINK_OUTSIDE,
                    f"symlink to '{target}' leaves the project root",
                )
            )
            return
        read_path = target

    # 6. Stat: size limit.
    try:
        stat = read_path.stat()
    except OSError as exc:
        result.skipped.append(SkippedFile(str(fpath), SKIP_UNREADABLE, str(exc)))
        return
    if stat.st_size > options.max_file_size_bytes:
        result.skipped.append(
            SkippedFile(
                str(fpath),
                SKIP_TOO_LARGE,
                f"{stat.st_size} bytes > limit {options.max_file_size_bytes}",
            )
        )
        return

    # 7. Binary: extension fast path + NUL sniff.
    suffix = PurePosixPath(rel).suffix.lower()
    if suffix in BINARY_EXTENSIONS:
        result.skipped.append(SkippedFile(str(fpath), SKIP_BINARY, f"binary extension '{suffix}'"))
        return
    if _looks_binary(str(read_path)):
        result.skipped.append(SkippedFile(str(fpath), SKIP_BINARY, "NUL byte in first 8 KB"))
        return

    result.candidates.append(
        FileCandidate(
            root=root_str,
            rel_path=rel,
            abs_path=str(read_path),
            size=stat.st_size,
            mtime=stat.st_mtime,
            language=language_for_path(rel),
        )
    )
