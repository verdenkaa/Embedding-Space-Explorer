"""End-to-end API tests for the corpus flow.

Flow: create project -> index (job) -> files/fragments/content/locate/search
-> change one file -> changes report -> confirmed re-index -> partial
recomputation with stable IDs -> delete.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.config import Settings
from app.storage.models import FileRow
from fastapi.testclient import TestClient

from tests.conftest import wait_for_job


@pytest.fixture
def project(client: TestClient, sample_project: Path) -> dict[str, object]:
    response = client.post(
        "/api/projects",
        json={"name": "Sample", "roots": [str(sample_project)]},
    )
    assert response.status_code == 201, response.text
    data: dict[str, object] = response.json()
    return data


def _index(client: TestClient, project_id: str) -> dict[str, object]:
    response = client.post(f"/api/projects/{project_id}/index")
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    return wait_for_job(client, project_id, job_id)


def test_full_corpus_flow(client: TestClient, project: dict[str, object]) -> None:
    pid = project["id"]
    assert isinstance(pid, str)

    # Initially empty stats.
    info = client.get(f"/api/projects/{pid}").json()
    assert info["stats"]["files_indexed"] == 0
    assert info["stats"]["fragments"] == 0

    job = _index(client, pid)
    assert job["state"] == "done", job
    assert "5 new" in str(job["message"])

    # Files: exactly the eligible five.
    files = client.get(f"/api/projects/{pid}/files").json()
    rel_paths = {f["rel_path"] for f in files}
    assert rel_paths == {
        "docs/guide.md",
        "notes/lorem.txt",
        "src/calculator.py",
        "src/utils.js",
        "web/types.ts",
    }
    calc = next(f for f in files if f["rel_path"] == "src/calculator.py")
    assert calc["fragment_count"] == 5
    assert calc["language"] == "python"

    # Project stats updated.
    info = client.get(f"/api/projects/{pid}").json()
    assert info["stats"]["files_indexed"] == 5
    assert info["stats"]["fragments"] > 15

    # File detail: fragments with correct ranges.
    detail = client.get(f"/api/projects/{pid}/files/{calc['id']}").json()
    by_symbol = {f["symbol_path"]: f for f in detail["fragments"]}
    assert by_symbol["Calculator.add"]["start_line"] == 15
    assert by_symbol["Calculator.add"]["end_line"] == 16

    # Content endpoint returns the real file.
    content = client.get(f"/api/projects/{pid}/files/{calc['id']}/content").json()
    assert content["content"].startswith('"""Sample calculator')
    assert content["total_lines"] == 25

    # Fragment detail carries text.
    frag_id = by_symbol["Calculator.add"]["id"]
    frag = client.get(f"/api/projects/{pid}/fragments/{frag_id}").json()
    assert frag["text"].strip().startswith("def add(")
    assert frag["rel_path"] == "src/calculator.py"


def test_locate_reverse_tracing(client: TestClient, project: dict[str, object]) -> None:
    pid = project["id"]
    assert isinstance(pid, str)
    _index(client, pid)
    files = client.get(f"/api/projects/{pid}/files").json()
    calc = next(f for f in files if f["rel_path"] == "src/calculator.py")

    # Lines of Calculator.add -> method first (most specific), then class.
    located = client.post(
        f"/api/projects/{pid}/files/{calc['id']}/locate",
        json={"start_line": 16, "end_line": 16},
    ).json()
    assert located["ambiguous"] is True
    assert [f["symbol_path"] for f in located["fragments"]] == ["Calculator.add", "Calculator"]
    assert located["note"]

    # Line without any fragment -> empty, not ambiguous.
    empty = client.post(
        f"/api/projects/{pid}/files/{calc['id']}/locate",
        json={"start_line": 6, "end_line": 6},
    ).json()
    assert empty["fragments"] == []
    assert empty["ambiguous"] is False

    # Invalid range -> 422.
    bad = client.post(
        f"/api/projects/{pid}/files/{calc['id']}/locate",
        json={"start_line": 10, "end_line": 5},
    )
    assert bad.status_code == 422


def test_fragment_search(client: TestClient, project: dict[str, object]) -> None:
    pid = project["id"]
    assert isinstance(pid, str)
    _index(client, pid)

    found = client.get(f"/api/projects/{pid}/fragments", params={"q": "helper"}).json()
    symbols = {i["symbol_path"] for i in found["items"]}
    assert symbols == {"Calculator.helper", "helper"}
    assert found["total"] == 2
    assert all(i["rel_path"] == "src/calculator.py" for i in found["items"])

    by_kind = client.get(f"/api/projects/{pid}/fragments", params={"kind": "section"}).json()
    assert by_kind["total"] == 4
    assert all(i["rel_path"] == "docs/guide.md" for i in by_kind["items"])


def test_incremental_reindex_keeps_stable_ids(
    client: TestClient, project: dict[str, object], sample_project: Path
) -> None:
    pid = project["id"]
    assert isinstance(pid, str)
    _index(client, pid)

    def fragment_ids(rel: str) -> dict[str, str]:
        files = client.get(f"/api/projects/{pid}/files").json()
        file_id = next(f["id"] for f in files if f["rel_path"] == rel)
        detail = client.get(f"/api/projects/{pid}/files/{file_id}").json()
        return {f["symbol_path"]: f["id"] for f in detail["fragments"]}

    calc_ids_before = fragment_ids("src/calculator.py")

    # No changes yet: report is empty.
    changes = client.get(f"/api/projects/{pid}/changes").json()
    assert changes["new"] == [] and changes["modified"] == [] and changes["deleted"] == []
    assert changes["unchanged_count"] == 5
    skipped_paths = {s["path"] for s in changes["skipped"]}
    assert any(p.endswith(".env") for p in skipped_paths)
    assert any("node_modules" in p for p in skipped_paths)

    # Modify one file, delete another, add a third.
    utils = sample_project / "src" / "utils.js"
    utils.write_text(
        utils.read_text(encoding="utf-8") + "\nfunction added() { return 1; }\n", encoding="utf-8"
    )
    (sample_project / "web" / "types.ts").unlink()
    (sample_project / "src" / "extra.py").write_text(
        "def extra():\n    return 42\n", encoding="utf-8"
    )

    changes = client.get(f"/api/projects/{pid}/changes").json()
    assert [c["rel_path"] for c in changes["new"]] == ["src/extra.py"]
    assert [c["rel_path"] for c in changes["modified"]] == ["src/utils.js"]
    assert changes["deleted"] == ["web/types.ts"]
    assert changes["unchanged_count"] == 3

    job = _index(client, pid)
    assert job["state"] == "done"
    assert "1 new" in str(job["message"]) and "1 modified" in str(job["message"])

    # Untouched file: identical fragment IDs (stable, cache-friendly).
    assert fragment_ids("src/calculator.py") == calc_ids_before

    # Modified file re-fragmented: new symbol present.
    utils_syms = fragment_ids("src/utils.js")
    assert "added" in utils_syms

    # Deleted file is gone; new file indexed.
    files = client.get(f"/api/projects/{pid}/files").json()
    rel_paths = {f["rel_path"] for f in files}
    assert "web/types.ts" not in rel_paths
    assert "src/extra.py" in rel_paths


def test_delete_requires_confirm(client: TestClient, project: dict[str, object]) -> None:
    pid = project["id"]
    assert isinstance(pid, str)
    refused = client.delete(f"/api/projects/{pid}")
    assert refused.status_code == 400
    assert refused.json()["error"]["code"] == "confirm_required"

    ok = client.delete(f"/api/projects/{pid}", params={"confirm": "true"})
    assert ok.status_code == 200
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_content_path_escape_blocked(
    client: TestClient, project: dict[str, object], settings: Settings
) -> None:
    pid = project["id"]
    assert isinstance(pid, str)
    _index(client, pid)

    files = client.get(f"/api/projects/{pid}/files").json()
    calc = next(f for f in files if f["rel_path"] == "src/calculator.py")

    # Tamper with the stored path directly in the DB (simulates a moved root
    # or a tampered row): the API must refuse to read outside the roots.
    from app.storage.projects_store import ProjectStore

    store = ProjectStore(Path(settings.data_dir))
    ctx = store.open(pid)
    with ctx.session_factory() as session:
        row = session.get(FileRow, calc["id"])
        assert row is not None
        row.abs_path = "/etc/hosts"
        session.commit()
    store.close_all()

    response = client.get(f"/api/projects/{pid}/files/{calc['id']}/content")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "path_escape"


def test_validation_errors(client: TestClient) -> None:
    empty_roots = client.post("/api/projects", json={"name": "x", "roots": []})
    assert empty_roots.status_code == 422

    missing_root = client.post(
        "/api/projects", json={"name": "x", "roots": ["/definitely/not/here"]}
    )
    assert missing_root.status_code == 400
    assert missing_root.json()["error"]["code"] == "invalid_roots"


def test_double_index_conflict(client: TestClient, project: dict[str, object]) -> None:
    pid = project["id"]
    assert isinstance(pid, str)
    first = client.post(f"/api/projects/{pid}/index")
    assert first.status_code == 202
    # Immediately again: either the first is still active (409) or already
    # done (202). Both are valid; a crash or silent double-run is not.
    second = client.post(f"/api/projects/{pid}/index")
    assert second.status_code in (202, 409)
    if second.status_code == 202:
        wait_for_job(client, pid, second.json()["id"])
    wait_for_job(client, pid, first.json()["id"])


def test_jobs_history(client: TestClient, project: dict[str, object]) -> None:
    pid = project["id"]
    assert isinstance(pid, str)
    _index(client, pid)
    jobs = client.get(f"/api/projects/{pid}/jobs").json()
    assert len(jobs) >= 1
    assert jobs[0]["kind"] == "index"
    assert jobs[0]["state"] == "done"
    assert jobs[0]["progress_total"] == 5
    assert jobs[0]["progress_done"] == 5


def test_staleness_indicator_flow(
    client: TestClient, project: dict[str, object], sample_project: Path
) -> None:
    pid = project["id"]
    assert isinstance(pid, str)

    # Before any indexing: everything is "new" -> dirty.
    stale = client.get(f"/api/projects/{pid}/staleness").json()
    assert stale["dirty"] is True
    assert stale["new_count"] == 5

    _index(client, pid)

    # Fresh index -> clean.
    stale = client.get(f"/api/projects/{pid}/staleness").json()
    assert stale["dirty"] is False
    assert stale["unchanged_count"] == 5
    assert (stale["new_count"], stale["modified_count"], stale["deleted_count"]) == (0, 0, 0)

    # New file -> dirty with new_count.
    fresh_file = sample_project / "src" / "fresh.py"
    fresh_file.write_text("def fresh():\n    return 1\n", encoding="utf-8")
    stale = client.get(f"/api/projects/{pid}/staleness").json()
    assert stale["dirty"] is True and stale["new_count"] == 1

    # Modified file -> modified_count (size/mtime path, no hashing needed).
    fresh_file.unlink()
    utils = sample_project / "src" / "utils.js"
    utils.write_text(utils.read_text(encoding="utf-8") + "\n// more\n", encoding="utf-8")
    stale = client.get(f"/api/projects/{pid}/staleness").json()
    assert stale["dirty"] is True and stale["modified_count"] == 1

    # Deleted file -> deleted_count.
    utils.write_text("function plainSum(a, b) {\n  return a + b;\n}\n", encoding="utf-8")
    (sample_project / "docs" / "guide.md").unlink()
    stale = client.get(f"/api/projects/{pid}/staleness").json()
    assert stale["dirty"] is True and stale["deleted_count"] == 1

    # After confirmed re-index the indicator goes dark again.
    _index(client, pid)
    stale = client.get(f"/api/projects/{pid}/staleness").json()
    assert stale["dirty"] is False
