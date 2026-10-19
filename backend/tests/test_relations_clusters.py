"""Tests: structural relations (extract/import/manual), clustering
(DBSCAN over an explicit space) and manual groups + db migration v4→v5.

Acceptance: "разделение семантических и структурных отношений" (the relations
API never mixes provenance and never touches similarity), "сохранение и
загрузка" (groups/clusters persist), "миграции схемы" (v4→v5 additive).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from app.clustering_methods.dbscan import (
    ClusteringParamsError,
    clustering_fingerprint,
    run_dbscan,
)
from app.config import Settings
from app.storage.projects_store import ProjectStore
from fastapi.testclient import TestClient

from tests.conftest import (
    FAKE_MODEL_ID,
    FakeProvider,
    create_indexed_project,
    wait_for_job,
)

# ---------------------------------------------------------------------------
# Helpers: embedded fixture project + a mini project with known imports
# ---------------------------------------------------------------------------


def _embedded_project(client: TestClient, sample_project: Path) -> tuple[str, str]:
    pid = create_indexed_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "raw_fragment"},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    return pid, runs[0]["id"]


A_PY = """from pkg.b import helper
import numpy


def main():
    return helper()


class C:
    def m(self):
        return 1
"""

B_PY = """def helper():
    return 1
"""

APP_JS = """import { x } from "./lib.js";

function run() {
  return x;
}
"""

LIB_JS = "export const x = 1;\n"


@pytest.fixture()
def mini_project(client: TestClient, tmp_path: Path) -> str:
    """A tiny indexed project with KNOWN import structure."""
    tree = tmp_path / "mini_tree"
    (tree / "pkg").mkdir(parents=True)
    (tree / "web").mkdir(parents=True)
    (tree / "pkg" / "a.py").write_text(A_PY, encoding="utf-8")
    (tree / "pkg" / "b.py").write_text(B_PY, encoding="utf-8")
    (tree / "web" / "app.js").write_text(APP_JS, encoding="utf-8")
    (tree / "web" / "lib.js").write_text(LIB_JS, encoding="utf-8")
    response = client.post("/api/projects", json={"name": "Mini", "roots": [str(tree)]})
    assert response.status_code == 201, response.text
    pid: str = str(response.json()["id"])
    job = client.post(f"/api/projects/{pid}/index").json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
    return pid


def _extract(client: TestClient, pid: str) -> dict[str, Any]:
    job = client.post(f"/api/projects/{pid}/relations/extract")
    assert job.status_code == 202, job.text
    return wait_for_job(client, pid, job.json()["id"])


def _fragment_by_symbol(client: TestClient, pid: str, symbol_path: str) -> dict[str, Any]:
    items: list[dict[str, Any]] = client.get(f"/api/projects/{pid}/fragments?limit=200").json()[
        "items"
    ]
    for item in items:
        if item["symbol_path"] == symbol_path:
            return item
    raise AssertionError(f"fragment '{symbol_path}' not found in {pid}")


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def test_extract_finds_imports_and_belongs_to(client: TestClient, mini_project: str) -> None:
    pid = mini_project
    info = _extract(client, pid)
    assert info["state"] == "done", info
    message = str(info["message"])
    assert "2 imports" in message and "1 unresolved" in message and "1 belongs_to" in message
    # the unresolved specifier is REPORTED (warning), never invented as a relation
    assert any("did not resolve" in w for w in info["warnings"])

    listed = client.get(f"/api/projects/{pid}/relations?limit=100").json()
    imports = [r for r in listed["items"] if r["kind"] == "imports"]
    assert len(imports) == 2
    by_detail = {r["detail"]: r for r in imports}
    assert set(by_detail) == {"pkg.b", "./lib.js"}

    py_import = by_detail["pkg.b"]
    assert py_import["origin"] == "extracted"
    assert py_import["confidence"] == 1.0
    assert py_import["source"]["rel_path"] == "pkg/a.py"
    # a top-level import belongs to NO fragment — honest file-level endpoint
    assert py_import["source"]["fragment_id"] is None
    assert py_import["target"]["rel_path"] == "pkg/b.py"
    assert py_import["target"]["fragment_id"] is None

    belongs = [r for r in listed["items"] if r["kind"] == "belongs_to"]
    assert len(belongs) == 1
    assert belongs[0]["source"]["symbol_path"] == "C.m"
    assert belongs[0]["target"]["symbol_path"] == "C"
    assert belongs[0]["source"]["fragment_id"] and belongs[0]["target"]["fragment_id"]

    assert listed["counts_by_kind"]["imports"] == 2
    assert listed["counts_by_origin"]["extracted"] == 3
    # no numpy relation exists anywhere
    assert all("numpy" not in json.dumps(r) for r in listed["items"])


def test_extract_is_idempotent_full_replace(client: TestClient, mini_project: str) -> None:
    pid = mini_project
    _extract(client, pid)
    first = client.get(f"/api/projects/{pid}/relations?limit=200").json()["total"]
    _extract(client, pid)
    second = client.get(f"/api/projects/{pid}/relations?limit=200").json()["total"]
    assert first == second == 3


def test_extract_keeps_manual_and_imported(client: TestClient, mini_project: str) -> None:
    pid = mini_project
    _extract(client, pid)
    main = _fragment_by_symbol(client, pid, "main")
    helper = _fragment_by_symbol(client, pid, "helper")
    created = client.post(
        f"/api/projects/{pid}/relations",
        json={
            "source_fragment_id": main["id"],
            "target_fragment_id": helper["id"],
            "kind": "calls",
            "detail": "hand-marked",
        },
    )
    assert created.status_code == 201, created.text
    _extract(client, pid)  # re-extraction must not touch provenance
    listed = client.get(f"/api/projects/{pid}/relations?origin=manual").json()
    assert listed["total"] == 1
    assert listed["items"][0]["kind"] == "calls"


# ---------------------------------------------------------------------------
# Manual relations
# ---------------------------------------------------------------------------


def test_manual_relation_validation(client: TestClient, mini_project: str) -> None:
    pid = mini_project
    main = _fragment_by_symbol(client, pid, "main")
    helper = _fragment_by_symbol(client, pid, "helper")

    self_rel = client.post(
        f"/api/projects/{pid}/relations",
        json={"source_fragment_id": main["id"], "target_fragment_id": main["id"], "kind": "calls"},
    )
    assert self_rel.status_code == 400

    unknown = client.post(
        f"/api/projects/{pid}/relations",
        json={
            "source_fragment_id": "nope0000000000",
            "target_fragment_id": helper["id"],
            "kind": "x",
        },
    )
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "fragment_not_found"

    created = client.post(
        f"/api/projects/{pid}/relations",
        json={
            "source_fragment_id": main["id"],
            "target_fragment_id": helper["id"],
            "kind": "calls",
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["origin"] == "manual" and body["confidence"] is None
    assert body["source"]["symbol_path"] == "main"
    assert body["target"]["rel_path"] == "pkg/b.py"

    # filter by fragment: relations involving `main`
    involving = client.get(f"/api/projects/{pid}/relations?fragment_id={main['id']}").json()
    assert involving["total"] == 1

    deleted = client.delete(f"/api/projects/{pid}/relations/{body['id']}")
    assert deleted.status_code == 200
    assert client.delete(f"/api/projects/{pid}/relations/{body['id']}").status_code == 404


# ---------------------------------------------------------------------------
# Import (ese-relations/v1)
# ---------------------------------------------------------------------------


def test_relations_import_reports_every_row(client: TestClient, mini_project: str) -> None:
    pid = mini_project
    payload = {
        "format": "ese-relations/v1",
        "relations": [
            {
                "kind": "calls",
                "source": {"path": "pkg/a.py", "symbol_path": "main"},
                "target": {"path": "pkg/b.py", "symbol_path": "helper"},
                "confidence": 0.9,
                "detail": "imported from an external corpus",
            },
            {
                "kind": "references",
                "source": {"path": "web/app.js"},
                "target": {"path": "web/lib.js"},
            },
            {
                "kind": "calls",
                "source": {"path": "pkg/a.py", "start_line": 999},
                "target": {"path": "pkg/b.py"},
            },
            {
                "kind": "tests",
                "source": {"path": "missing_test.py"},
                "target": {"path": "pkg/b.py"},
            },
        ],
    }
    response = client.post(f"/api/projects/{pid}/relations/import", json=payload)
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["imported"] == 2
    assert report["duplicates"] == 0
    assert len(report["unresolved"]) == 2
    reasons = " | ".join(u["reason"] for u in report["unresolved"])
    assert "line 999" in reasons
    assert "missing_test.py" in reasons

    # the imported rows carry origin=imported and the resolved endpoints
    imported = client.get(f"/api/projects/{pid}/relations?origin=imported").json()
    assert imported["total"] == 2
    calls = next(r for r in imported["items"] if r["kind"] == "calls")
    assert calls["confidence"] == 0.9
    assert calls["source"]["symbol_path"] == "main"
    refs = next(r for r in imported["items"] if r["kind"] == "references")
    assert refs["source"]["fragment_id"] is None  # file-level endpoint stayed honest

    # re-import: duplicates are counted, never double-inserted
    again = client.post(f"/api/projects/{pid}/relations/import", json=payload).json()
    assert again["imported"] == 0
    assert again["duplicates"] == 2


def test_relations_import_format_errors(client: TestClient, mini_project: str) -> None:
    pid = mini_project
    cases = [
        {"format": "something/else", "relations": []},
        {"format": "ese-relations/v1", "relations": {}},
        {"format": "ese-relations/v1", "relations": [{"kind": "calls", "source": {}}]},
        {
            "format": "ese-relations/v1",
            "relations": [
                {
                    "kind": "calls",
                    "source": {"path": "pkg/a.py"},
                    "target": {"path": "pkg/b.py"},
                    "confidence": 1.5,
                }
            ],
        },
        {
            "format": "ese-relations/v1",
            "relations": [
                {
                    "kind": "calls",
                    "source": {"path": "pkg/a.py", "start_line": 0},
                    "target": {"path": "pkg/b.py"},
                }
            ],
        },
    ]
    for case in cases:
        response = client.post(f"/api/projects/{pid}/relations/import", json=case)
        assert response.status_code == 400, case
        error = response.json()["error"]
        assert error["code"] == "invalid_relations_format"
        assert "ese-relations/v1" in str(error["hint"]) or "ese-relations/v1" in error["message"]


# ---------------------------------------------------------------------------
# Clustering: unit geometry
# ---------------------------------------------------------------------------

BLOBS = np.array(
    [
        [1.0, 0.0],
        [1.1, 0.0],
        [0.9, 0.1],
        [0.0, 2.0],
        [0.0, 2.1],
        [0.1, 1.9],
        [9.0, 9.0],  # noise
    ],
    dtype=np.float32,
)


def test_dbscan_two_blobs_and_honest_noise() -> None:
    labels = run_dbscan(BLOBS, metric="euclidean", eps=0.5, min_samples=2)
    assert labels.shape == (7,)
    unique = {int(x) for x in labels if x >= 0}
    assert len(unique) == 2
    assert labels[0] == labels[1] == labels[2]
    assert labels[3] == labels[4] == labels[5]
    assert labels[0] != labels[3]
    assert labels[6] == -1  # noise stays noise — never a "meaning"


def test_dbscan_guards_and_fingerprint() -> None:
    with pytest.raises(ClusteringParamsError, match="eps"):
        run_dbscan(BLOBS, metric="euclidean", eps=0.0, min_samples=2)
    with pytest.raises(ClusteringParamsError, match="min_samples"):
        run_dbscan(BLOBS, metric="euclidean", eps=0.5, min_samples=1)
    with pytest.raises(ClusteringParamsError, match="metric"):
        run_dbscan(BLOBS, metric="manhattan", eps=0.5, min_samples=2)

    a = clustering_fingerprint("e1", "original", None, "dbscan", "cosine", {"eps": 0.5})
    assert a == clustering_fingerprint("e1", "original", None, "dbscan", "cosine", {"eps": 0.5})
    assert a != clustering_fingerprint("e1", "original", None, "dbscan", "cosine", {"eps": 0.6})
    assert a != clustering_fingerprint("e1", "projection", "p1", "dbscan", "cosine", {"eps": 0.5})


# ---------------------------------------------------------------------------
# Clustering: API
# ---------------------------------------------------------------------------


def test_clustering_api_original_space(
    client: TestClient,
    sample_project: Path,
    settings: Settings,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    job = client.post(
        f"/api/projects/{pid}/clustering/compute",
        json={
            "embedding_run_id": run_id,
            "space": "original",
            "params": {"eps": 1.0, "min_samples": 2},
        },
    )
    assert job.status_code == 202, job.text
    info = wait_for_job(client, pid, job.json()["id"])
    assert info["state"] == "done", info
    assert "DBSCAN over original vectors" in str(info["message"])

    inventory = client.get(f"/api/projects/{pid}/clustering").json()
    assert len(inventory) == 1
    run = inventory[0]
    assert run["space"] == "original"
    assert run["metric"] == "cosine"  # default for the original space
    assert run["algorithm"] == "dbscan"
    assert run["params"] == {"eps": 1.0, "min_samples": 2}
    assert run["count"] == 21
    assert run["cache_ok"] is True and run["stale"] is False
    assert run["versions"].get("scikit-learn")

    labels = client.get(f"/api/projects/{pid}/clustering/{run['id']}/labels").json()
    assert len(labels["ids"]) == 21 and len(labels["labels"]) == 21
    assert labels["noise"] == sum(1 for x in labels["labels"] if x == -1)
    assigned = {x for x in labels["labels"] if x >= 0}
    assert labels["n_clusters"] == len(assigned)

    # idempotent recompute: same fingerprint → still exactly one run
    job = client.post(
        f"/api/projects/{pid}/clustering/compute",
        json={
            "embedding_run_id": run_id,
            "space": "original",
            "params": {"eps": 1.0, "min_samples": 2},
        },
    ).json()
    wait_for_job(client, pid, job["id"])
    assert len(client.get(f"/api/projects/{pid}/clustering").json()) == 1

    # staleness is signature-driven: tamper with the stored signature
    from app.storage.db import open_database
    from app.storage.models import ClusteringRunRow

    db_path = settings.data_dir / "projects" / pid / "project.db"
    engine, factory = open_database(db_path)
    with factory() as session:
        row = session.get(ClusteringRunRow, run["id"])
        assert row is not None
        row.source_signature = "0" * 32
        session.commit()
    engine.dispose()
    assert client.get(f"/api/projects/{pid}/clustering").json()[0]["stale"] is True

    # damaged label cache → honest 409 (never an empty cloud)
    npz = settings.data_dir / "projects" / pid / "cache" / "clustering" / f"{run['id']}.npz"
    npz.write_bytes(b"not an npz archive")
    damaged = client.get(f"/api/projects/{pid}/clustering/{run['id']}/labels")
    assert damaged.status_code == 409
    assert damaged.json()["error"]["code"] == "clustering_cache_unavailable"
    assert client.get(f"/api/projects/{pid}/clustering").json()[0]["cache_ok"] is False

    # delete removes row + file
    assert client.delete(f"/api/projects/{pid}/clustering/{run['id']}").status_code == 200
    assert not npz.exists()
    assert client.get(f"/api/projects/{pid}/clustering").json() == []
    assert client.delete(f"/api/projects/{pid}/clustering/{run['id']}").status_code == 404


def test_clustering_api_projection_space(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [2]},
    ).json()
    wait_for_job(client, pid, job["id"])
    proj_id = client.get(f"/api/projects/{pid}/projections").json()[0]["id"]

    # cosine over projection coordinates is refused with an explanation
    bad = client.post(
        f"/api/projects/{pid}/clustering/compute",
        json={
            "embedding_run_id": run_id,
            "space": "projection",
            "projection_run_id": proj_id,
            "metric": "cosine",
            "params": {"eps": 0.5, "min_samples": 2},
        },
    )
    assert bad.status_code == 400
    error = bad.json()["error"]
    assert "euclidean" in error["message"]
    assert "not interpretable" in str(error["hint"])

    missing_proj = client.post(
        f"/api/projects/{pid}/clustering/compute",
        json={"embedding_run_id": run_id, "space": "projection"},
    )
    assert missing_proj.status_code == 400

    job = client.post(
        f"/api/projects/{pid}/clustering/compute",
        json={
            "embedding_run_id": run_id,
            "space": "projection",
            "projection_run_id": proj_id,
            "params": {"eps": 0.5, "min_samples": 2},
        },
    )
    assert job.status_code == 202, job.text
    info = wait_for_job(client, pid, job.json()["id"])
    assert info["state"] == "done", info
    run = client.get(f"/api/projects/{pid}/clustering").json()[0]
    assert run["space"] == "projection"
    assert run["projection_run_id"] == proj_id
    assert run["metric"] == "euclidean"  # honest default for projection space
    labels = client.get(f"/api/projects/{pid}/clustering/{run['id']}/labels").json()
    assert labels["space"] == "projection"
    assert len(labels["ids"]) == 21


# ---------------------------------------------------------------------------
# Manual groups
# ---------------------------------------------------------------------------


def test_groups_crud_and_validation(client: TestClient, mini_project: str) -> None:
    pid = mini_project
    main = _fragment_by_symbol(client, pid, "main")
    helper = _fragment_by_symbol(client, pid, "helper")

    created = client.post(
        f"/api/projects/{pid}/groups",
        json={"name": "interesting", "fragment_ids": [main["id"], helper["id"], main["id"]]},
    )
    assert created.status_code == 201, created.text
    group = created.json()
    assert group["count"] == 2  # duplicates collapse
    assert set(group["fragment_ids"]) == {main["id"], helper["id"]}

    dup = client.post(
        f"/api/projects/{pid}/groups",
        json={"name": "interesting", "fragment_ids": [main["id"]]},
    )
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "group_name_taken"

    unknown = client.post(
        f"/api/projects/{pid}/groups",
        json={"name": "ghosts", "fragment_ids": ["nope0000000000"]},
    )
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "unknown_fragments"

    listed = client.get(f"/api/projects/{pid}/groups").json()
    assert [g["name"] for g in listed] == ["interesting"]
    assert listed[0]["count"] == 2

    assert client.delete(f"/api/projects/{pid}/groups/{group['id']}").status_code == 200
    assert client.get(f"/api/projects/{pid}/groups").json() == []
    assert client.delete(f"/api/projects/{pid}/groups/{group['id']}").status_code == 404


# ---------------------------------------------------------------------------
# Migration v4 → v5 (additive, with backup)
# ---------------------------------------------------------------------------


def test_db_migration_v4_to_v5_keeps_existing_data(settings: Settings) -> None:
    from app.storage.db import CURRENT_DB_SCHEMA, open_database
    from app.storage.models import EmbeddingRunRow, ProjectionRunRow
    from sqlalchemy import text

    store = ProjectStore(settings.data_dir)
    ctx = store.create_project("mig45", [str(Path(__file__).parent)])
    db_path = ctx.project_dir / "project.db"
    with ctx.session_factory() as session:
        session.add(
            EmbeddingRunRow(
                id="emb-keep-0001",
                model_id="m",
                dim=8,
                mode="raw_fragment",
                template="",
                params_json="{}",
                npz_relpath="cache/embeddings/x.npz",
                count=3,
                created_at="2026-10-16T10:00:00+00:00",
                updated_at="2026-10-16T10:00:00+00:00",
            )
        )
        session.add(
            ProjectionRunRow(
                id="proj-keep-0001",
                embedding_run_id="emb-keep-0001",
                method="pca",
                n_components=3,
                params_json="{}",
                seed=42,
                axis_labels_json='["PC1","PC2","PC3"]',
                versions_json="{}",
                npz_relpath="cache/projections/x.npz",
                count=3,
                source_signature="sig",
                created_at="2026-10-16T10:00:00+00:00",
                updated_at="2026-10-16T10:00:00+00:00",
            )
        )
        session.commit()

    # Simulate a (v4) database: drop the tables.
    with ctx.engine.begin() as conn:
        for table in (
            "fragment_group_members",
            "fragment_groups",
            "relations",
            "clustering_runs",
            "saved_slices",
        ):
            conn.execute(text(f"DROP TABLE {table}"))
        conn.execute(text("UPDATE meta SET value='4' WHERE key='schema_version'"))
    store.close_all()

    engine, factory = open_database(db_path)
    with factory() as session:
        kept = session.get(ProjectionRunRow, "proj-keep-0001")
        assert kept is not None and kept.count == 3
        assert session.get(EmbeddingRunRow, "emb-keep-0001") is not None
    with engine.connect() as conn:
        version = conn.execute(
            text("SELECT value FROM meta WHERE key='schema_version'")
        ).scalar_one()
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
    engine.dispose()

    assert version == str(CURRENT_DB_SCHEMA)
    for table in (
        "relations",
        "clustering_runs",
        "fragment_groups",
        "fragment_group_members",
        "saved_slices",
    ):
        assert table in tables
    backups = list(ctx.project_dir.glob("project.db.bak-*"))
    assert len(backups) == 1
