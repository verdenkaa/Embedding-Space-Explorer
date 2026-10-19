"""tests: Jupyter Notebooks — .ipynb format, file API, kernel sessions, ese bridge.

Kernel tests run a REAL ipykernel (one per session, ~1 s startup each):
state between cells, stdout/stderr/traceback outputs, interrupt, restart,
session isolation and project binding, output caps and the session limit.
The ese-bridge test computes real embeddings (fake provider) and reads them
from inside the kernel through `ese.project` — the acceptance path of TZ §4.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from app.notebooks import format as nbfmt
from fastapi.testclient import TestClient

from tests.conftest import FAKE_MODEL_ID, FakeProvider, create_indexed_project, wait_for_job

# ---------------------------------------------------------------------------
# Pure format tests (no kernel)
# ---------------------------------------------------------------------------


def test_new_notebook_is_valid_nbformat4_with_project_binding() -> None:
    nb = nbfmt.new_notebook("proj123")
    assert nb.nbformat == 4
    assert nb.metadata["ese"]["project_id"] == "proj123"
    assert nb.metadata["kernelspec"]["language"] == "python"
    nbfmt.normalize(nb)
    assert nbfmt.validate(nb) == []
    text = nbfmt.serialize_notebook(nb)
    assert json.loads(text)["cells"][0]["cell_type"] == "code"


def test_read_damaged_notebook_reports_instead_of_crashing(tmp_path: Path) -> None:
    broken = tmp_path / "broken.ipynb"
    broken.write_text("{not json at all", encoding="utf-8")
    with pytest.raises(nbfmt.NotebookFormatError):
        nbfmt.read_notebook_file(broken)

    not_a_nb = tmp_path / "other.ipynb"
    not_a_nb.write_text(json.dumps({"hello": "world"}), encoding="utf-8")
    with pytest.raises(nbfmt.NotebookFormatError):
        nbfmt.read_notebook_file(not_a_nb)


def test_normalize_fills_cell_ids_and_preserves_unknown_outputs() -> None:
    payload = {
        "cells": [
            {
                "cell_type": "code",
                "source": ["print(1)\n"],  # list-form source
                "metadata": {},
                "execution_count": 1,
                "outputs": [
                    # An exotic MIME type the editor may not render — must survive.
                    {
                        "output_type": "display_data",
                        "data": {"application/x-custom": "binary-ish-payload"},
                        "metadata": {},
                    }
                ],
            },
            {"cell_type": "markdown", "source": "# t", "metadata": {}, "outputs": ["junk"]},
        ],
        "metadata": {"custom_tool": {"keep": True}},
        "nbformat": 4,
        "nbformat_minor": 4,
    }
    nb = nbfmt.notebook_from_json(payload)
    problems = nbfmt.normalize(nb)
    assert problems == []
    assert nb.cells[0].id and nb.cells[1].id and nb.cells[0].id != nb.cells[1].id
    assert nb.cells[0].source == "print(1)\n"
    assert nb.cells[0].outputs[0]["data"]["application/x-custom"] == "binary-ish-payload"
    # markdown cell lost its invalid outputs, notebook metadata kept
    assert "outputs" not in nb.cells[1]
    assert nb.metadata["custom_tool"] == {"keep": True}
    assert nb.nbformat_minor == 5


def test_notebook_from_json_rejects_structural_junk() -> None:
    with pytest.raises(nbfmt.NotebookFormatError):
        nbfmt.notebook_from_json([1, 2, 3])
    with pytest.raises(nbfmt.NotebookFormatError):
        nbfmt.notebook_from_json({"cells": "not a list"})
    with pytest.raises(nbfmt.NotebookFormatError):
        nbfmt.notebook_from_json({"cells": [{"cell_type": "sql", "source": ""}]})


# ---------------------------------------------------------------------------
# API: notebook files
# ---------------------------------------------------------------------------


@pytest.fixture
def project(client: TestClient, sample_project: Path) -> str:
    response = client.post("/api/projects", json={"name": "Nb", "roots": [str(sample_project)]})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def nb_url(client: TestClient, pid: str) -> str:
    return f"/api/projects/{pid}/notebooks"


def test_notebook_create_list_read_save(client: TestClient, project: str) -> None:
    url = nb_url(client, project)

    assert client.get(url).json() == []

    created = client.post(url, json={"path": "notebooks/geometry.ipynb"})
    assert created.status_code == 201, created.text

    listing = client.get(url).json()
    assert [item["path"] for item in listing] == ["notebooks/geometry.ipynb"]

    content = client.get(f"{url}/content", params={"path": "notebooks/geometry.ipynb"}).json()
    assert content["valid"] is True
    assert content["ese_project_id"] == project
    assert content["notebook"]["nbformat"] == 4
    mtime = content["mtime"]

    # Edit: add a markdown cell, save with base_mtime.
    notebook = content["notebook"]
    notebook["cells"].append({"cell_type": "markdown", "source": "# Гипотеза", "metadata": {}})
    saved = client.put(
        f"{url}/content",
        json={"path": "notebooks/geometry.ipynb", "notebook": notebook, "base_mtime": mtime},
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["valid"] is True
    # Saved file is real on disk and re-readable.
    again = client.get(f"{url}/content", params={"path": "notebooks/geometry.ipynb"}).json()
    assert len(again["notebook"]["cells"]) == 2
    # The normalize step assigned an id to the new cell.
    assert again["notebook"]["cells"][1]["id"]


def test_notebook_save_conflict_and_force(client: TestClient, project: str) -> None:
    url = nb_url(client, project)
    client.post(url, json={"path": "notebooks/c.ipynb"})
    content = client.get(f"{url}/content", params={"path": "notebooks/c.ipynb"}).json()

    # External change (e.g. by another editor) after the client read.
    tree = client.get(f"/api/projects/{project}/workspace/tree").json()
    on_disk = Path(tree["root"]) / "notebooks" / "c.ipynb"
    import os

    os.utime(on_disk, (content["mtime"] + 10, content["mtime"] + 10))

    response = client.put(
        f"{url}/content",
        json={
            "path": "notebooks/c.ipynb",
            "notebook": content["notebook"],
            "base_mtime": content["mtime"],
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "workspace_conflict"

    forced = client.put(
        f"{url}/content",
        json={
            "path": "notebooks/c.ipynb",
            "notebook": content["notebook"],
            "base_mtime": content["mtime"],
            "force": True,
        },
    )
    assert forced.status_code == 200


def test_notebook_rejects_wrong_extension_and_damaged_file(
    client: TestClient, project: str
) -> None:
    url = nb_url(client, project)
    wrong = client.post(url, json={"path": "notebooks/notes.md"})
    assert wrong.status_code == 400
    assert wrong.json()["error"]["code"] == "not_a_notebook"

    # A damaged .ipynb on disk: honest 422, no crash of the app/tree.
    client.post(
        f"/api/projects/{project}/workspace/file",
        json={"path": "notebooks/bad.ipynb", "content": "{broken"},
    )
    response = client.get(f"{url}/content", params={"path": "notebooks/bad.ipynb"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "notebook_invalid"
    # It is still listed (the file exists) — the UI can rename/delete it.
    assert any(item["path"] == "notebooks/bad.ipynb" for item in client.get(url).json())


# ---------------------------------------------------------------------------
# Kernel sessions (real ipykernel)
# ---------------------------------------------------------------------------


def wait_session(
    client: TestClient, pid: str, sid: str, states: tuple[str, ...], timeout: float = 60.0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/projects/{pid}/notebooks/sessions/{sid}")
        assert response.status_code == 200, response.text
        last = response.json()
        if last["state"] in states:
            return last
        time.sleep(0.2)
    pytest.fail(f"session {sid} did not reach {states} in {timeout}s; last: {last}")


def start_ready_session(client: TestClient, pid: str, path: str) -> str:
    response = client.post(f"/api/projects/{pid}/notebooks/sessions", json={"path": path})
    assert response.status_code in (200, 201), response.text
    sid = str(response.json()["session_id"])
    session = wait_session(client, pid, sid, ("ready", "error"), timeout=90)
    assert session["state"] == "ready", session
    return sid


def execute_and_wait(
    client: TestClient, pid: str, sid: str, code: str, timeout: float = 60.0
) -> dict[str, Any]:
    response = client.post(
        f"/api/projects/{pid}/notebooks/sessions/{sid}/execute", json={"code": code}
    )
    assert response.status_code == 200, response.text
    eid = str(response.json()["execution_id"])
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        poll = client.get(f"/api/projects/{pid}/notebooks/sessions/{sid}/executions/{eid}")
        assert poll.status_code == 200, poll.text
        last = poll.json()
        if last["status"] != "running":
            return last
        time.sleep(0.1)
    pytest.fail(f"execution {eid} did not finish in {timeout}s; last: {last}")


def test_kernel_state_persists_between_cells(client: TestClient, project: str) -> None:
    client.post(nb_url(client, project), json={"path": "notebooks/k1.ipynb"})
    sid = start_ready_session(client, project, "notebooks/k1.ipynb")

    first = execute_and_wait(client, project, sid, "x = 41\nx")
    assert first["status"] == "done"
    assert first["outputs"][-1]["data"]["text/plain"] == "41"
    count_1 = first["execution_count"]
    assert isinstance(count_1, int) and count_1 >= 1

    second = execute_and_wait(client, project, sid, "x + 1")
    assert second["status"] == "done"
    assert second["outputs"][-1]["data"]["text/plain"] == "42"
    assert second["execution_count"] == count_1 + 1


def test_kernel_streams_and_traceback(client: TestClient, project: str) -> None:
    client.post(nb_url(client, project), json={"path": "notebooks/k2.ipynb"})
    sid = start_ready_session(client, project, "notebooks/k2.ipynb")

    result = execute_and_wait(
        client,
        project,
        sid,
        "import sys\nprint('out-line')\nprint('err-line', file=sys.stderr)\n1/0",
    )
    assert result["status"] == "done"  # the cell "ran"; the error is an output
    kinds = [o["output_type"] for o in result["outputs"]]
    assert "stream" in kinds and "error" in kinds
    streams = [o["text"] for o in result["outputs"] if o["output_type"] == "stream"]
    assert any("out-line" in t for t in streams)
    error = next(o for o in result["outputs"] if o["output_type"] == "error")
    assert error["ename"] == "ZeroDivisionError"
    assert any("ZeroDivisionError" in line for line in error["traceback"])
    assert "ZeroDivisionError" in (result["error"] or "")


def test_kernel_cwd_is_project_workspace_and_env_is_set(client: TestClient, project: str) -> None:
    client.post(nb_url(client, project), json={"path": "notebooks/k3.ipynb"})
    sid = start_ready_session(client, project, "notebooks/k3.ipynb")

    result = execute_and_wait(
        client,
        project,
        sid,
        "import os, json, sys, importlib.util\n"
        "print(json.dumps({'cwd': os.getcwd(), 'pid': os.environ.get('ESE_PROJECT_ID'),"
        " 'on_path': 'ese' in sys.modules or importlib.util.find_spec('ese') is not None}))",
    )
    payload = json.loads(result["outputs"][0]["text"])
    tree = client.get(f"/api/projects/{project}/workspace/tree").json()
    assert Path(payload["cwd"]) == Path(tree["root"])
    assert payload["pid"] == project
    assert payload["on_path"] is True


def test_kernel_interrupt_stops_long_execution(client: TestClient, project: str) -> None:
    client.post(nb_url(client, project), json={"path": "notebooks/k4.ipynb"})
    sid = start_ready_session(client, project, "notebooks/k4.ipynb")

    response = client.post(
        f"/api/projects/{project}/notebooks/sessions/{sid}/execute",
        json={"code": "import time\ntime.sleep(60)"},
    )
    assert response.status_code == 200, response.text
    eid = str(response.json()["execution_id"])

    time.sleep(0.5)
    interrupt = client.post(f"/api/projects/{project}/notebooks/sessions/{sid}/interrupt")
    assert interrupt.status_code == 200

    deadline = time.monotonic() + 30
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = client.get(
            f"/api/projects/{project}/notebooks/sessions/{sid}/executions/{eid}"
        ).json()
        if last["status"] != "running":
            break
        time.sleep(0.1)
    assert last["status"] == "interrupted", last
    assert any(
        o["output_type"] == "error" and o["ename"] == "KeyboardInterrupt" for o in last["outputs"]
    )

    # The kernel survives an interrupt and keeps state semantics.
    after = execute_and_wait(client, project, sid, "1 + 1")
    assert after["status"] == "done"


def test_kernel_restart_resets_state(client: TestClient, project: str) -> None:
    client.post(nb_url(client, project), json={"path": "notebooks/k5.ipynb"})
    sid = start_ready_session(client, project, "notebooks/k5.ipynb")

    execute_and_wait(client, project, sid, "persisted = 'value'")
    restart = client.post(f"/api/projects/{project}/notebooks/sessions/{sid}/restart")
    assert restart.status_code == 200
    wait_session(client, project, sid, ("ready", "error"), timeout=90)

    result = execute_and_wait(client, project, sid, "'persisted' in dir()")
    assert result["status"] == "done"
    assert result["outputs"][-1]["data"]["text/plain"] == "False"


def test_sessions_are_isolated_between_notebooks(client: TestClient, project: str) -> None:
    url = nb_url(client, project)
    client.post(url, json={"path": "notebooks/a.ipynb"})
    client.post(url, json={"path": "notebooks/b.ipynb"})
    sid_a = start_ready_session(client, project, "notebooks/a.ipynb")
    sid_b = start_ready_session(client, project, "notebooks/b.ipynb")
    assert sid_a != sid_b

    execute_and_wait(client, project, sid_a, "only_in_a = 7")
    result = execute_and_wait(client, project, sid_b, "'only_in_a' in dir()")
    assert result["outputs"][-1]["data"]["text/plain"] == "False"


def test_session_of_other_project_is_not_found(client: TestClient, sample_project: Path) -> None:
    first = client.post("/api/projects", json={"name": "A", "roots": [str(sample_project)]}).json()
    second_root = sample_project.parent / "second_root"
    second_root.mkdir(exist_ok=True)
    (second_root / "m.py").write_text("def f():\n    return 1\n", encoding="utf-8")
    other = client.post("/api/projects", json={"name": "B", "roots": [str(second_root)]}).json()

    client.post(f"/api/projects/{first['id']}/notebooks", json={"path": "notebooks/x.ipynb"})
    sid = start_ready_session(client, first["id"], "notebooks/x.ipynb")

    # The same session id under another project does not exist there.
    cross = client.get(f"/api/projects/{other['id']}/notebooks/sessions/{sid}")
    assert cross.status_code == 404
    cross_exec = client.post(
        f"/api/projects/{other['id']}/notebooks/sessions/{sid}/execute", json={"code": "1"}
    )
    assert cross_exec.status_code == 404
    listing = client.get(f"/api/projects/{other['id']}/notebooks/sessions").json()
    assert listing == []


def test_execute_before_ready_is_refused(client: TestClient, project: str) -> None:
    client.post(nb_url(client, project), json={"path": "notebooks/k6.ipynb"})
    url = f"/api/projects/{project}/notebooks"
    sid = client.post(f"{url}/sessions", json={"path": "notebooks/k6.ipynb"}).json()["session_id"]
    # Immediately after start the kernel may still be booting; if it is not
    # ready yet the API must say so honestly instead of losing the code.
    session = client.get(f"{url}/sessions/{sid}").json()
    if session["state"] != "ready":
        response = client.post(f"{url}/sessions/{sid}/execute", json={"code": "1"})
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "kernel_not_ready"
    # Eventually it becomes usable.
    wait_session(client, project, sid, ("ready", "error"), timeout=90)


def test_session_limit_is_enforced(
    client: TestClient, project: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.notebooks.kernel_manager as km_mod

    monkeypatch.setattr(km_mod, "MAX_SESSIONS", 1)
    url = nb_url(client, project)
    client.post(url, json={"path": "notebooks/l1.ipynb"})
    client.post(url, json={"path": "notebooks/l2.ipynb"})
    start_ready_session(client, project, "notebooks/l1.ipynb")
    second = client.post(f"{url}/sessions", json={"path": "notebooks/l2.ipynb"})
    assert second.status_code == 503
    assert second.json()["error"]["code"] == "kernel_limit"


def test_close_session_shuts_kernel_down(client: TestClient, project: str) -> None:
    client.post(nb_url(client, project), json={"path": "notebooks/k7.ipynb"})
    sid = start_ready_session(client, project, "notebooks/k7.ipynb")
    closed = client.delete(f"/api/projects/{project}/notebooks/sessions/{sid}")
    assert closed.status_code == 200
    assert client.get(f"/api/projects/{project}/notebooks/sessions/{sid}").status_code == 404
    # Starting again gives a NEW session (no resurrection of the dead one).
    sid2 = start_ready_session(client, project, "notebooks/k7.ipynb")
    assert sid2 != sid


# ---------------------------------------------------------------------------
# ese bridge — the acceptance path of TZ §4 (real embeddings read from kernel)
# ---------------------------------------------------------------------------


def test_ese_bridge_reads_project_data_from_kernel(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid = create_indexed_project(client, sample_project)

    job = client.post(
        f"/api/projects/{pid}/models/download", json={"model_id": FAKE_MODEL_ID}
    ).json()
    wait_for_job(client, pid, job["id"])
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "raw_fragment", "batch_size": 4},
    ).json()
    info = wait_for_job(client, pid, job["id"], timeout=60)
    assert info["state"] == "done", info

    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    assert runs, "embedding run must exist"
    run_id = runs[0]["id"]

    client.post(nb_url(client, pid), json={"path": "notebooks/bridge.ipynb"})
    sid = start_ready_session(client, pid, "notebooks/bridge.ipynb")

    code = f"""
import json
from ese import project

p = project.current()
info = p.info()
spaces = p.list_spaces()
sp = p.open_space({run_id!r})
X = sp.embeddings()
ids = sp.ids
frags = sp.fragments()
nb = sp.neighbors(str(ids[0]), k=3)
text = sp.fragment_text(str(ids[0]))

# Результаты эксперимента сохраняются в рабочем пространстве, не в основном хранилище.
out = p.results_dir / "bridge_report.json"
report = {{
    "project": info["id"],
    "spaces": len(spaces),
    "n": int(X.shape[0]),
    "dim": int(X.shape[1]),
    "ids_match": int(len(ids)) == int(X.shape[0]),
    "fragments": len(frags),
    "neighbors": [n["fragment_id"] for n in nb],
    "text_len": len(text),
    "other_visible": len(project.list_projects()),
}}
out.write_text(json.dumps(report), encoding="utf-8")
print(json.dumps(report))
"""
    result = execute_and_wait(client, pid, sid, code, timeout=120)
    assert result["status"] == "done", result
    stream = next(o for o in result["outputs"] if o["output_type"] == "stream")
    report = json.loads(stream["text"])

    assert report["project"] == pid
    assert report["spaces"] == 1
    assert report["n"] == 21  # every fixture fragment embedded by the fake provider
    assert report["dim"] == 8  # FAKE_DIM
    assert report["ids_match"] is True
    assert report["fragments"] == 21
    assert len(report["neighbors"]) == 3
    assert report["text_len"] > 0
    assert report["other_visible"] >= 1

    # The results file is real, on disk, inside workspace/results.
    tree = client.get(f"/api/projects/{pid}/workspace/tree").json()
    saved = Path(tree["root"]) / "results" / "bridge_report.json"
    assert saved.is_file()
    assert json.loads(saved.read_text("utf-8"))["project"] == pid

    # The bridge is read-only: the main store is untouched (corpus intact).
    files = client.get(f"/api/projects/{pid}/files").json()
    assert len(files) > 0


def test_ese_bridge_rejects_write_to_main_store(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid = create_indexed_project(client, sample_project)
    client.post(nb_url(client, pid), json={"path": "notebooks/ro.ipynb"})
    sid = start_ready_session(client, pid, "notebooks/ro.ipynb")

    code = """
from ese import project
from sqlalchemy import text as sql_text
p = project.current()
try:
    with p._session() as session:
        session.execute(sql_text("CREATE TABLE hacked (x)"))
    print("WROTE")
except Exception as exc:
    print("READONLY:" + exc.__class__.__name__)
"""
    result = execute_and_wait(client, pid, sid, code)
    stream = next(o for o in result["outputs"] if o["output_type"] == "stream")
    assert stream["text"].startswith("READONLY:"), stream["text"]


def test_matplotlib_image_output(client: TestClient, project: str) -> None:
    pytest.importorskip("matplotlib")
    client.post(nb_url(client, project), json={"path": "notebooks/plot.ipynb"})
    sid = start_ready_session(client, project, "notebooks/plot.ipynb")
    result = execute_and_wait(
        client,
        project,
        sid,
        "%matplotlib inline\n"
        "import matplotlib.pyplot as plt\n"
        "plt.plot([1, 2, 3], [1, 4, 9])\n"
        "plt.show()\n",
        timeout=120,
    )
    assert result["status"] == "done", result
    pngs = [
        o
        for o in result["outputs"]
        if o["output_type"] in ("display_data", "execute_result")
        and "image/png" in o.get("data", {})
    ]
    assert pngs, f"expected an image/png output, got {result['outputs']}"
    assert len(pngs[0]["data"]["image/png"]) > 100  # real base64 payload
