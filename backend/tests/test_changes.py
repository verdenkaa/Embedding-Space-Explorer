"""Change classification tests (TZ scenario D, §9.3)."""

from __future__ import annotations

import os
import time
from pathlib import Path

from app.fragmentation.base import SplitOptions
from app.source_registry.changes import ExistingFileInfo, classify_changes, hash_file
from app.source_registry.scanner import scan_roots


def _existing(root: Path, rel: str, *, status: str = "indexed") -> ExistingFileInfo:
    path = root / rel
    stat = path.stat()
    return ExistingFileInfo(
        id=rel.replace("/", "-"),
        root=str(root),
        rel_path=rel,
        abs_path=str(path),
        size=stat.st_size,
        mtime=stat.st_mtime,
        content_hash=hash_file(str(path)),
        status=status,
    )


def test_no_changes(sample_project: Path) -> None:
    scan = scan_roots([str(sample_project)], SplitOptions())
    existing = [_existing(sample_project, c.rel_path) for c in scan.candidates]
    plan = classify_changes(scan, existing)
    assert plan.new == []
    assert plan.modified == []
    assert plan.deleted == []
    assert plan.unchanged_count == len(existing)


def test_modified_content_detected(sample_project: Path) -> None:
    scan = scan_roots([str(sample_project)], SplitOptions())
    existing = [_existing(sample_project, c.rel_path) for c in scan.candidates]

    target = sample_project / "src" / "utils.js"
    target.write_text(target.read_text(encoding="utf-8") + "\n// touched\n", encoding="utf-8")

    scan2 = scan_roots([str(sample_project)], SplitOptions())
    plan = classify_changes(scan2, existing)
    assert [c.rel_path for c in plan.modified] == ["src/utils.js"]
    assert plan.modified[0].reason in ("content", "size")
    assert plan.new == []
    assert plan.deleted == []


def test_touch_only_is_unchanged(sample_project: Path) -> None:
    scan = scan_roots([str(sample_project)], SplitOptions())
    existing = [_existing(sample_project, c.rel_path) for c in scan.candidates]

    target = sample_project / "src" / "calculator.py"
    os.utime(target, (time.time() + 5, time.time() + 5))

    scan2 = scan_roots([str(sample_project)], SplitOptions())
    plan = classify_changes(scan2, existing)
    # Size equal, mtime differs -> hash check proves content unchanged.
    assert plan.modified == []
    assert plan.unchanged_count == len(existing)


def test_new_and_deleted(sample_project: Path) -> None:
    scan = scan_roots([str(sample_project)], SplitOptions())
    existing = [_existing(sample_project, c.rel_path) for c in scan.candidates]

    (sample_project / "src" / "extra.py").write_text("x = 1\n", encoding="utf-8")
    (sample_project / "web" / "types.ts").unlink()

    scan2 = scan_roots([str(sample_project)], SplitOptions())
    plan = classify_changes(scan2, existing)
    assert [c.rel_path for c in plan.new] == ["src/extra.py"]
    assert [d.rel_path for d in plan.deleted] == ["web/types.ts"]


def test_error_rows_are_retried_as_new(sample_project: Path) -> None:
    scan = scan_roots([str(sample_project)], SplitOptions())
    existing = [_existing(sample_project, c.rel_path) for c in scan.candidates]
    existing[0] = ExistingFileInfo(
        id=existing[0].id,
        root=existing[0].root,
        rel_path=existing[0].rel_path,
        abs_path=existing[0].abs_path,
        size=existing[0].size,
        mtime=existing[0].mtime,
        content_hash=None,
        status="error",
    )
    plan = classify_changes(scan, existing)
    assert [c.rel_path for c in plan.new] == [existing[0].rel_path]
