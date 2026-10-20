"""tests: research workspace (tree, text CRUD, path safety, open-folder).

The workspace must behave like a real on-disk document store of the project:
relative-path API, atomic saves, optimistic-concurrency conflict detection,
and hard refusal of any path outside the workspace (traversal, absolute,
symlink escape). open-folder accepts ONLY fixed subdir names.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from app.workspace import store as ws
from fastapi.testclient import TestClient


@pytest.fixture
def project(client: TestClient, sample_project: Path) -> str:
    response = client.post("/api/projects", json={"name": "Ws", "roots": [str(sample_project)]})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def base(client: TestClient, pid: str) -> str:
    return f"/api/projects/{pid}/workspace"


# ---------------------------------------------------------------------------
# Tree & skeleton
# ---------------------------------------------------------------------------


def test_tree_creates_skeleton_on_first_use(client: TestClient, project: str) -> None:
    response = client.get(f"{base(client, project)}/tree")
    assert response.status_code == 200, response.text
    data = response.json()
    names = {e["name"] for e in data["entries"] if e["kind"] == "dir"}
    assert set(ws.WORKSPACE_SUBDIRS) <= names
    assert data["truncated"] is False
    # Root is reported for display only and points inside the project dir.
    assert data["root"].endswith("workspace")


def test_tree_lists_nested_files(client: TestClient, project: str) -> None:
    client.post(
        f"{base(client, project)}/file", json={"path": "notes/deep/idea.md", "content": "# hi"}
    )
    data = client.get(f"{base(client, project)}/tree").json()
    paths = {e["path"] for e in data["entries"]}
    assert "notes/deep/idea.md" in paths
    assert "notes/deep" in paths
    entry = next(e for e in data["entries"] if e["path"] == "notes/deep/idea.md")
    assert entry["kind"] == "file"
    assert entry["size"] > 0
    assert entry["mtime"] > 0


def test_tree_hides_dot_files_and_tmp(client: TestClient, project: str) -> None:
    client.post(f"{base(client, project)}/file", json={"path": "notes/.hidden.md", "content": "x"})
    data = client.get(f"{base(client, project)}/tree").json()
    assert ".hidden.md" not in {e["name"] for e in data["entries"]}


# ---------------------------------------------------------------------------
# Text CRUD
# ---------------------------------------------------------------------------


def test_create_read_save_roundtrip(client: TestClient, project: str) -> None:
    url = base(client, project)
    created = client.post(f"{url}/file", json={"path": "notes/obs.md", "content": "первая строка"})
    assert created.status_code == 201, created.text

    read = client.get(f"{url}/file", params={"path": "notes/obs.md"})
    assert read.status_code == 200
    body = read.json()
    assert body["content"] == "первая строка"
    assert body["size"] == len("первая строка".encode())

    saved = client.put(
        f"{url}/file",
        json={"path": "notes/obs.md", "content": "вторая", "base_mtime": body["mtime"]},
    )
    assert saved.status_code == 200, saved.text
    again = client.get(f"{url}/file", params={"path": "notes/obs.md"}).json()
    assert again["content"] == "вторая"


def test_create_conflict_when_exists(client: TestClient, project: str) -> None:
    url = base(client, project)
    client.post(f"{url}/file", json={"path": "notes/a.md", "content": ""})
    response = client.post(f"{url}/file", json={"path": "notes/a.md", "content": ""})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "workspace_exists"


def test_create_directory(client: TestClient, project: str) -> None:
    response = client.post(
        f"{base(client, project)}/file", json={"path": "datasets/run1", "kind": "dir"}
    )
    assert response.status_code == 201
    assert response.json()["kind"] == "dir"


def test_read_missing_file_404(client: TestClient, project: str) -> None:
    response = client.get(f"{base(client, project)}/file", params={"path": "notes/nope.md"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "workspace_not_found"


def test_binary_file_rejected(client: TestClient, project: str) -> None:
    # Write raw bytes behind the API's back (simulates a user-dropped file).
    tree = client.get(f"{base(client, project)}/tree").json()
    root = Path(tree["root"])
    (root / "datasets" / "blob.bin").write_bytes(b"\x00\xff\xfe")
    response = client.get(f"{base(client, project)}/file", params={"path": "datasets/blob.bin"})
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "workspace_binary_file"


# ---------------------------------------------------------------------------
# Raw binary serving (images referenced by notes, stage 4)
# ---------------------------------------------------------------------------

_PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _write_raw(client: TestClient, project: str, rel: str, data: bytes) -> None:
    tree = client.get(f"{base(client, project)}/tree").json()
    target = Path(tree["root"]) / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def test_raw_serves_binary_with_content_type(client: TestClient, project: str) -> None:
    _write_raw(client, project, "results/plot.png", _PNG_BYTES)
    response = client.get(f"{base(client, project)}/raw", params={"path": "results/plot.png"})
    assert response.status_code == 200, response.text
    assert response.content == _PNG_BYTES
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-content-type-options"] == "nosniff"
    # Inline, not attachment: browsers render it inside <img>.
    assert "inline" in response.headers.get("content-disposition", "")


def test_raw_downgrades_html_to_text(client: TestClient, project: str) -> None:
    _write_raw(client, project, "notes/page.html", b"<script>alert(1)</script>")
    response = client.get(f"{base(client, project)}/raw", params={"path": "notes/page.html"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")


def test_raw_missing_file_404(client: TestClient, project: str) -> None:
    response = client.get(f"{base(client, project)}/raw", params={"path": "results/nope.png"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "workspace_not_found"


def test_raw_directory_rejected(client: TestClient, project: str) -> None:
    client.get(f"{base(client, project)}/tree")  # ensure skeleton
    response = client.get(f"{base(client, project)}/raw", params={"path": "results"})
    assert response.status_code == 404


@pytest.mark.parametrize("bad", ["../secret.png", "/etc/passwd", "notes/../../x.png"])
def test_raw_traversal_rejected(client: TestClient, project: str, bad: str) -> None:
    response = client.get(f"{base(client, project)}/raw", params={"path": bad})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "workspace_invalid_path"


def test_raw_size_cap(client: TestClient, project: str, monkeypatch: pytest.MonkeyPatch) -> None:
    _write_raw(client, project, "results/big.png", b"x" * 64)
    monkeypatch.setattr(ws, "MAX_RAW_BYTES", 32)
    response = client.get(f"{base(client, project)}/raw", params={"path": "results/big.png"})
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "workspace_file_too_large"


# ---------------------------------------------------------------------------
# Optimistic concurrency (TZ §6.5)
# ---------------------------------------------------------------------------


def test_save_conflict_when_changed_on_disk(client: TestClient, project: str) -> None:
    url = base(client, project)
    client.post(f"{url}/file", json={"path": "notes/conf.md", "content": "v1"})
    seen = client.get(f"{url}/file", params={"path": "notes/conf.md"}).json()

    # External edit (e.g. by the notebook kernel) after the client read.
    tree = client.get(f"{url}/tree").json()
    on_disk = Path(tree["root"]) / "notes" / "conf.md"
    on_disk.write_text("external", encoding="utf-8")
    import os

    os.utime(on_disk, (seen["mtime"] + 10, seen["mtime"] + 10))

    response = client.put(
        f"{url}/file", json={"path": "notes/conf.md", "content": "v2", "base_mtime": seen["mtime"]}
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "workspace_conflict"

    # Force overwrite is an explicit user decision.
    forced = client.put(
        f"{url}/file",
        json={"path": "notes/conf.md", "content": "v2", "base_mtime": seen["mtime"], "force": True},
    )
    assert forced.status_code == 200
    assert client.get(f"{url}/file", params={"path": "notes/conf.md"}).json()["content"] == "v2"


# ---------------------------------------------------------------------------
# Rename & delete
# ---------------------------------------------------------------------------


def test_rename_file_and_dir(client: TestClient, project: str) -> None:
    url = base(client, project)
    client.post(f"{url}/file", json={"path": "notes/old.md", "content": "data"})
    renamed = client.post(
        f"{url}/rename", json={"from_path": "notes/old.md", "to_path": "notes/new.md"}
    )
    assert renamed.status_code == 200, renamed.text
    assert client.get(f"{url}/file", params={"path": "notes/new.md"}).json()["content"] == "data"
    assert client.get(f"{url}/file", params={"path": "notes/old.md"}).status_code == 404

    client.post(f"{url}/file", json={"path": "datasets/d1/f.txt", "content": "x"})
    moved = client.post(
        f"{url}/rename", json={"from_path": "datasets/d1", "to_path": "datasets/d2"}
    )
    assert moved.status_code == 200
    assert client.get(f"{url}/file", params={"path": "datasets/d2/f.txt"}).status_code == 200


def test_rename_to_existing_409(client: TestClient, project: str) -> None:
    url = base(client, project)
    client.post(f"{url}/file", json={"path": "notes/a.md", "content": ""})
    client.post(f"{url}/file", json={"path": "notes/b.md", "content": ""})
    response = client.post(
        f"{url}/rename", json={"from_path": "notes/a.md", "to_path": "notes/b.md"}
    )
    assert response.status_code == 409


def test_delete_file_and_dir(client: TestClient, project: str) -> None:
    url = base(client, project)
    client.post(f"{url}/file", json={"path": "notes/tmp.md", "content": ""})
    assert client.delete(f"{url}/file", params={"path": "notes/tmp.md"}).status_code == 200
    assert client.get(f"{url}/file", params={"path": "notes/tmp.md"}).status_code == 404

    client.post(f"{url}/file", json={"path": "results/r1/out.txt", "content": "x"})
    # Directory without confirm is refused (destructive op needs consent).
    refused = client.delete(f"{url}/file", params={"path": "results/r1"})
    assert refused.status_code == 400
    confirmed = client.delete(f"{url}/file", params={"path": "results/r1", "confirm": "true"})
    assert confirmed.status_code == 200


# ---------------------------------------------------------------------------
# Path safety (TZ §10: the backend owns the allowed root)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "../project.db",
        "notes/../../project.json",
        "/etc/passwd",
        "C:/Windows/system32",
        "..",
        ".",
        "notes/.",
        ".hidden/x.md",
    ],
)
def test_traversal_and_absolute_paths_rejected(client: TestClient, project: str, bad: str) -> None:
    url = base(client, project)
    assert client.get(f"{url}/file", params={"path": bad}).status_code == 400
    assert client.post(f"{url}/file", json={"path": bad, "content": "x"}).status_code == 400
    assert client.put(f"{url}/file", json={"path": bad, "content": "x"}).status_code == 400
    assert client.delete(f"{url}/file", params={"path": bad}).status_code == 400


def test_symlink_escape_rejected(client: TestClient, project: str) -> None:
    import os as os_mod

    if os_mod.name == "nt":
        pytest.skip("POSIX symlink test")
    url = base(client, project)
    tree = client.get(f"{url}/tree").json()
    root = Path(tree["root"])
    outside = root.parent / "project.json"  # exists, sensitive
    link = root / "notes" / "escape.md"
    link.symlink_to(outside)
    response = client.get(f"{url}/file", params={"path": "notes/escape.md"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "workspace_invalid_path"


def test_workspace_separate_from_corpus(client: TestClient, project: str) -> None:
    """Workspace documents must never appear in the indexed corpus list."""
    url = base(client, project)
    client.post(f"{url}/file", json={"path": "notes/hypothesis.md", "content": "# H1"})
    client.post(
        f"{url}/file", json={"path": "notebooks/geo.ipynb", "content": json.dumps({"cells": []})}
    )
    files = client.get(f"/api/projects/{project}/files").json()
    rel_paths = {f["rel_path"] for f in files}
    assert "hypothesis.md" not in rel_paths
    assert not any("workspace" in p for p in rel_paths)


# ---------------------------------------------------------------------------
# open-folder (TZ §3.3)
# ---------------------------------------------------------------------------


def test_open_folder_only_fixed_subdirs(
    client: TestClient, project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = base(client, project)
    for bad in ("../../..", "/tmp", "project.db", "cache"):
        response = client.post(f"{url}/open-folder", json={"sub": bad})
        assert response.status_code == 400, bad

    calls: list[list[str]] = []

    def fake_popen(cmd: list[str], **kwargs: object) -> None:
        calls.append(cmd)

    import subprocess

    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    response = client.post(f"{url}/open-folder", json={"sub": "notes"})
    assert response.status_code == 200
    body = response.json()
    assert body["path"].endswith("workspace/notes") or body["path"].endswith("workspace\\notes")
    # Opened depends on the platform helper; on win32 os.startfile is used and
    # Popen is not called — assert at least the path is honest and absolute.
    assert Path(body["path"]).is_absolute()


def test_open_folder_root(client: TestClient, project: str) -> None:
    response = client.post(f"{base(client, project)}/open-folder", json={})
    assert response.status_code == 200
    assert response.json()["path"].endswith("workspace")
