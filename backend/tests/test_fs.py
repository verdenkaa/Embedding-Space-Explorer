"""Directory browser endpoint tests (root picker)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient


def test_list_dirs_returns_directories_only(client: TestClient, sample_project: Path) -> None:
    response = client.get("/api/fs/list-dirs", params={"path": str(sample_project)})
    assert response.status_code == 200
    data = response.json()
    names = {e["name"] for e in data["entries"]}
    assert {"src", "docs", "web", "notes"} <= names
    # Never file names.
    assert "calculator.py" not in names
    assert "lorem.txt" not in names
    assert data["parent"] == str(sample_project.parent)
    assert data["drives"] is False


def test_list_dirs_hides_dot_directories(client: TestClient, sample_project: Path) -> None:
    (sample_project / ".hidden_dir").mkdir()
    data = client.get("/api/fs/list-dirs", params={"path": str(sample_project)}).json()
    names = {e["name"] for e in data["entries"]}
    assert ".hidden_dir" not in names


def test_list_dirs_nonexistent_path(client: TestClient, tmp_path: Path) -> None:
    data = client.get("/api/fs/list-dirs", params={"path": str(tmp_path / "nope")}).json()
    assert data["entries"] == []


def test_list_dirs_default_root(client: TestClient) -> None:
    data = client.get("/api/fs/list-dirs").json()
    # POSIX: entries of "/"; Windows: drive list. Either way a list.
    assert isinstance(data["entries"], list)
