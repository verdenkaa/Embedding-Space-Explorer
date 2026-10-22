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


def test_read_text_safely_normalizes_line_endings(tmp_path: Path) -> None:
    """Second-audit item 6: CRLF (Windows core.autocrlf) vs LF must not change
    the decoded text — otherwise stable fragment IDs differ across machines
    and caches/saved experiments stop matching the corpus after a re-clone."""
    from app.source_registry.changes import read_text_safely

    src = "def alpha(x):\n    return x + 1\n\nclass Beta:\n    pass\n"
    lf = tmp_path / "lf.py"
    crlf = tmp_path / "crlf.py"
    cr = tmp_path / "cr.py"
    lf.write_bytes(src.encode("utf-8"))
    crlf.write_bytes(src.replace("\n", "\r\n").encode("utf-8"))
    cr.write_bytes(src.replace("\n", "\r").encode("utf-8"))

    text_lf, err_lf = read_text_safely(str(lf))
    text_crlf, err_crlf = read_text_safely(str(crlf))
    text_cr, err_cr = read_text_safely(str(cr))
    assert err_lf is None and err_crlf is None and err_cr is None
    assert "\r" not in (text_crlf or "") and "\r" not in (text_cr or "")
    assert text_lf == text_crlf == text_cr == src


def test_fragment_ids_identical_for_crlf_and_lf(tmp_path: Path) -> None:
    """End-to-end consequence of item 6: the SAME logical file fragmented via
    CRLF and via LF must yield identical stable fragment IDs."""
    from app.fragmentation.base import SplitOptions
    from app.fragmentation.registry import fragment_file
    from app.source_registry.changes import read_text_safely

    src = "def alpha(x):\n    return x + 1\n\nclass Beta:\n    def gamma(self):\n        return 2\n"
    lf = tmp_path / "mod.py"
    crlf = tmp_path / "mod.py"
    lf.write_bytes(src.encode("utf-8"))
    text_lf, _ = read_text_safely(str(lf))
    crlf.write_bytes(src.replace("\n", "\r\n").encode("utf-8"))
    text_crlf, _ = read_text_safely(str(crlf))
    assert text_lf is not None and text_crlf is not None

    res_lf = fragment_file(rel_path="mod.py", text=text_lf, options=SplitOptions())
    res_crlf = fragment_file(rel_path="mod.py", text=text_crlf, options=SplitOptions())
    ids_lf = [(f.symbol_path, f.fragment_id, f.content_hash) for f in res_lf.fragments]
    ids_crlf = [(f.symbol_path, f.fragment_id, f.content_hash) for f in res_crlf.fragments]
    assert ids_lf, "the fixture must fragment into something"
    assert ids_lf == ids_crlf
