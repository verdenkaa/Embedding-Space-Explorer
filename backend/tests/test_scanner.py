"""Scanner tests: exclusions, secrets, binaries, size limits, symlinks."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from app.fragmentation.base import SplitOptions
from app.source_registry.defaults import (
    SKIP_BINARY,
    SKIP_EXCLUDED_DIR,
    SKIP_EXCLUDED_PATTERN,
    SKIP_SECRET,
    SKIP_SYMLINK_OUTSIDE,
    SKIP_TOO_LARGE,
)
from app.source_registry.scanner import scan_roots


def _rel_paths(result: object) -> set[str]:
    return {c.rel_path for c in result.candidates}  # type: ignore[attr-defined]


def _skipped_by_reason(result: object) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for s in result.skipped:  # type: ignore[attr-defined]
        out.setdefault(s.reason, []).append(s.path)
    return out


def test_sample_project_scan(sample_project: Path) -> None:
    result = scan_roots([str(sample_project)], SplitOptions())
    assert result.root_errors == []
    assert _rel_paths(result) == {
        "docs/guide.md",
        "notes/lorem.txt",
        "src/calculator.py",
        "src/utils.js",
        "web/types.ts",
    }
    skipped = _skipped_by_reason(result)
    assert any(".env" in p for p in skipped[SKIP_SECRET])
    assert any("blob.bin" in p for p in skipped[SKIP_BINARY])
    assert any("node_modules" in p for p in skipped[SKIP_EXCLUDED_DIR])


def test_deterministic_order(sample_project: Path) -> None:
    a = scan_roots([str(sample_project)], SplitOptions())
    b = scan_roots([str(sample_project)], SplitOptions())
    assert [c.rel_path for c in a.candidates] == [c.rel_path for c in b.candidates]


def test_exclude_pattern(sample_project: Path) -> None:
    options = SplitOptions(extra_exclude_patterns=["*.js"])
    result = scan_roots([str(sample_project)], options)
    assert "src/utils.js" not in _rel_paths(result)
    assert any(
        s.reason == SKIP_EXCLUDED_PATTERN and s.path.endswith("utils.js") for s in result.skipped
    )


def test_include_pattern_filters(sample_project: Path) -> None:
    options = SplitOptions(extra_include_patterns=["*.py"])
    result = scan_roots([str(sample_project)], options)
    assert _rel_paths(result) == {"src/calculator.py"}


def test_secret_file_explicit_include_warns(sample_project: Path) -> None:
    options = SplitOptions(extra_include_patterns=[".env"])
    result = scan_roots([str(sample_project)], options)
    assert ".env" in _rel_paths(result)
    assert any("secret-like file included" in w for w in result.warnings)


def test_too_large_file_skipped(sample_project: Path) -> None:
    big = sample_project / "notes" / "big.txt"
    big.write_bytes(b"x" * (1_100_000))
    result = scan_roots([str(sample_project)], SplitOptions())
    assert "notes/big.txt" not in _rel_paths(result)
    assert any(s.reason == SKIP_TOO_LARGE and s.path.endswith("big.txt") for s in result.skipped)


def test_binary_sniffing_without_extension(sample_project: Path) -> None:
    weird = sample_project / "notes" / "mystery"
    weird.write_bytes(b"header\x00\x01\x02binary")
    result = scan_roots([str(sample_project)], SplitOptions())
    assert "notes/mystery" not in _rel_paths(result)
    assert any(s.reason == SKIP_BINARY and s.path.endswith("mystery") for s in result.skipped)


def test_missing_root_reported(sample_project: Path) -> None:
    result = scan_roots([str(sample_project / "nope")], SplitOptions())
    assert result.root_errors
    assert result.candidates == []


def test_nested_roots_rejected(sample_project: Path) -> None:
    result = scan_roots([str(sample_project), str(sample_project / "src")], SplitOptions())
    assert any("inside another root" in e for e in result.root_errors)


def test_single_file_root(sample_project: Path) -> None:
    result = scan_roots([str(sample_project / "src" / "calculator.py")], SplitOptions())
    assert len(result.candidates) == 1
    assert result.candidates[0].rel_path == "calculator.py"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlink semantics")
def test_symlink_escaping_root_skipped(sample_project: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("secret outside content", encoding="utf-8")
    link = sample_project / "notes" / "escape.txt"
    os.symlink(outside, link)

    result = scan_roots([str(sample_project)], SplitOptions())
    assert "notes/escape.txt" not in _rel_paths(result)
    assert any(s.reason == SKIP_SYMLINK_OUTSIDE for s in result.skipped)

    allowed = scan_roots([str(sample_project)], SplitOptions(allow_symlinks_outside_root=True))
    assert "notes/escape.txt" in _rel_paths(allowed)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlink semantics")
def test_symlinked_dir_escaping_root_not_followed(sample_project: Path, tmp_path: Path) -> None:
    outside_dir = tmp_path / "outside_dir"
    outside_dir.mkdir()
    (outside_dir / "inner.py").write_text("x = 1\n", encoding="utf-8")
    os.symlink(outside_dir, sample_project / "linked_dir")

    result = scan_roots([str(sample_project)], SplitOptions())
    assert not any(p.startswith("linked_dir/") for p in _rel_paths(result))
    assert any(s.reason == SKIP_SYMLINK_OUTSIDE for s in result.skipped)
