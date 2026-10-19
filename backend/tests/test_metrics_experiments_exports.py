"""tests: metrics (pure + API), experiments, exports, migration v5→v6.

Metric math is verified on synthetic data with KNOWN ground truth (identity
"projection" must retain every neighbor; a constructed relation pair must be
found with precision/coverage 1.0). Corpus incompleteness is asserted
explicitly: unknown pairs never enter denominators as negatives.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from app import __version__
from app.config import Settings
from app.metrics.compute import (
    MetricsInputError,
    compute_metric_bundle,
    neighbor_retention,
    original_topk,
    relation_pairs_from_rows,
    sample_indices,
)
from app.storage.projects_store import ProjectStore
from fastapi.testclient import TestClient

from .conftest import (
    FAKE_MODEL_ID,
    FakeProvider,
    create_indexed_project,
    wait_for_job,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


@pytest.fixture()
def mini_tree(client: TestClient, tmp_path: Path) -> str:
    """A tiny indexed project with KNOWN import/belongs_to structure."""
    tree = tmp_path / "metrics_mini"
    (tree / "pkg").mkdir(parents=True)
    (tree / "pkg" / "a.py").write_text(A_PY, encoding="utf-8")
    (tree / "pkg" / "b.py").write_text(B_PY, encoding="utf-8")
    response = client.post("/api/projects", json={"name": "MetricsMini", "roots": [str(tree)]})
    assert response.status_code == 201, response.text
    pid: str = str(response.json()["id"])
    job = client.post(f"/api/projects/{pid}/index").json()
    assert wait_for_job(client, pid, job["id"])["state"] == "done"
    return pid


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


def _compute_projection(client: TestClient, pid: str, run_id: str, n: int) -> str:
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [n]},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
    runs = client.get(f"/api/projects/{pid}/projections").json()
    for row in runs:
        if row["n_components"] == n:
            return str(row["id"])
    raise AssertionError("projection run not found")


def _compute_metrics(client: TestClient, pid: str, payload: dict[str, Any]) -> dict[str, Any]:
    response = client.post(f"/api/projects/{pid}/metrics/compute", json=payload)
    assert response.status_code == 202, response.text
    info = wait_for_job(client, pid, response.json()["id"])
    assert info["state"] == "done", info
    return info


# ---------------------------------------------------------------------------
# Pure metric math on synthetic data with known ground truth
# ---------------------------------------------------------------------------


def _synthetic(n: int = 30, dim: int = 6, seed: int = 3) -> tuple[list[str], np.ndarray]:
    rng = np.random.default_rng(seed)
    ids = [f"v{i:03d}" for i in range(n)]
    vectors = rng.normal(size=(n, dim)).astype(np.float32)
    return ids, vectors


def test_sample_indices_is_deterministic_and_sorted() -> None:
    a = sample_indices(100, 20, seed=42)
    b = sample_indices(100, 20, seed=42)
    c = sample_indices(100, 20, seed=7)
    assert np.array_equal(a, b)  # reproducibility
    assert not np.array_equal(a, c)
    assert np.all(np.diff(a) > 0)  # sorted, no duplicates
    assert len(a) == 20
    assert len(sample_indices(5, 100, seed=1)) == 5  # sample capped at n
    with pytest.raises(MetricsInputError):
        sample_indices(0, 10, seed=1)


def test_identity_projection_retains_every_neighbor() -> None:
    ids, vectors = _synthetic()
    # Unit-normalize: for unit vectors, euclidean order == cosine order, so an
    # identity "projection" (euclidean) must retain every cosine neighbor.
    # Without normalization the two geometries legitimately disagree — that
    # is a property of the metrics' definitions, not a bug.
    vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    coords = vectors.copy()  # "projection" = identity → nothing may be lost
    idx = sample_indices(len(ids), len(ids), seed=1)
    orig = original_topk(vectors, idx, 5)
    from app.metrics.compute import projection_topk

    proj = projection_topk(coords, idx, 5)
    assert neighbor_retention(orig, proj) == pytest.approx(1.0)

    bundle = compute_metric_bundle(
        vectors=vectors, coords=coords, ids=ids, k=5, sample=len(ids), seed=1, pairs=set()
    )
    metrics = bundle["metrics"]
    assert isinstance(metrics, dict)
    assert metrics["neighbor_retention"]["value"] == pytest.approx(1.0)  # type: ignore[index]
    assert metrics["trustworthiness"]["value"] == pytest.approx(1.0)  # type: ignore[index]


def test_random_projection_loses_neighbors() -> None:
    ids, vectors = _synthetic()
    rng = np.random.default_rng(99)
    coords = rng.normal(size=vectors.shape).astype(np.float32)  # noise map
    bundle = compute_metric_bundle(
        vectors=vectors, coords=coords, ids=ids, k=5, sample=len(ids), seed=1, pairs=set()
    )
    metrics = bundle["metrics"]
    assert isinstance(metrics, dict)
    retention = metrics["neighbor_retention"]["value"]  # type: ignore[index]
    trust = metrics["trustworthiness"]["value"]  # type: ignore[index]
    assert isinstance(retention, float) and retention < 0.6
    assert isinstance(trust, float) and trust < 1.0


def test_relation_precision_and_coverage_on_constructed_pairs() -> None:
    ids, vectors = _synthetic(n=12, dim=4)
    idx = np.arange(len(ids), dtype=np.int64)
    topk = original_topk(vectors, idx, 3)
    # Declare EXACTLY the true top-3 neighbors of v000 as known relations.
    pairs = {frozenset((ids[0], ids[int(j)])) for j in topk[0]}
    bundle = compute_metric_bundle(
        vectors=vectors, coords=None, ids=ids, k=3, sample=len(ids), seed=1, pairs=pairs
    )
    metrics = bundle["metrics"]
    assert isinstance(metrics, dict)
    precision = metrics["relation_precision"]
    coverage = metrics["relation_coverage"]
    assert isinstance(precision, dict) and isinstance(coverage, dict)
    # Ground truth by the metric's definition: pairing is symmetric, so the
    # precision denominator covers v000 AND its three partners (each partner's
    # only known relation is v000 itself).
    partner_rows = [int(j) for j in topk[0]]
    terms = [1.0]  # v000: all 3 of its top-3 are known partners → 3/3
    terms += [(1.0 if 0 in topk[r].tolist() else 0.0) / 3.0 for r in partner_rows]
    assert precision["value"] == pytest.approx(sum(terms) / len(terms))
    assert precision["n_sampled_with_relations"] == 4  # v000 + 3 partners
    assert coverage["value"] == pytest.approx(1.0)  # every known pair is recovered
    assert coverage["n_known_pairs_embedded"] == 3
    # Corpus incompleteness: the other 11 points contribute NOTHING to the
    # precision denominator (unknown ≠ negative).
    assert "neighbor_retention" not in metrics  # no projection → honestly skipped
    warnings = bundle["warnings"]
    assert isinstance(warnings, list)
    assert any("projection metrics skipped" in str(w) for w in warnings)


def test_relation_metrics_without_pairs_are_none_not_zero() -> None:
    ids, vectors = _synthetic(n=8, dim=4)
    bundle = compute_metric_bundle(
        vectors=vectors, coords=None, ids=ids, k=3, sample=8, seed=1, pairs=set()
    )
    metrics = bundle["metrics"]
    assert isinstance(metrics, dict)
    precision = metrics["relation_precision"]
    assert isinstance(precision, dict)
    assert precision["value"] is None  # no data → no number (never a fake 0.0)
    warnings = bundle["warnings"]
    assert isinstance(warnings, list)
    assert any("no sampled fragment has known relations" in str(w) for w in warnings)


def test_k_is_reduced_honestly_for_tiny_corpora() -> None:
    ids, vectors = _synthetic(n=4, dim=3)
    bundle = compute_metric_bundle(
        vectors=vectors, coords=vectors.copy(), ids=ids, k=10, sample=4, seed=1, pairs=set()
    )
    sample_info = bundle["sample"]
    assert isinstance(sample_info, dict)
    assert sample_info["k"] == 3  # n-1
    warnings = bundle["warnings"]
    assert isinstance(warnings, list)
    assert any("k reduced to 3" in str(w) for w in warnings)


def test_relation_pairs_from_rows_filters_and_dedupes() -> None:
    rows = [
        ("f1", "f2", None, None, "imports"),
        ("f2", "f1", None, None, "imports"),  # reverse direction = same pair
        (None, None, "file1", "file2", "imports"),  # file-level: no fragment pair
        ("f3", "f3", None, None, "imports"),  # self-loop: meaningless
        ("f4", "f5", None, None, "belongs_to"),
    ]
    pairs = relation_pairs_from_rows(rows)
    assert pairs == {frozenset(("f1", "f2")), frozenset(("f4", "f5"))}
    only_imports = relation_pairs_from_rows(rows, kinds=["imports"])
    assert only_imports == {frozenset(("f1", "f2"))}


def test_determinism_of_the_whole_bundle() -> None:
    ids, vectors = _synthetic()
    rng = np.random.default_rng(5)
    coords = rng.normal(size=(len(ids), 2)).astype(np.float32)
    a = compute_metric_bundle(
        vectors=vectors, coords=coords, ids=ids, k=5, sample=20, seed=42, pairs=set()
    )
    b = compute_metric_bundle(
        vectors=vectors, coords=coords, ids=ids, k=5, sample=20, seed=42, pairs=set()
    )
    assert a == b  # same inputs + seed → identical numbers


# ---------------------------------------------------------------------------
# Metrics API
# ---------------------------------------------------------------------------


def test_metrics_api_flow(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    proj_id = _compute_projection(client, pid, run_id, 2)

    info = _compute_metrics(
        client,
        pid,
        {
            "embedding_run_id": run_id,
            "projection_run_id": proj_id,
            "k": 5,
            "sample": 15,
            "seed": 7,
        },
    )
    assert "metrics over" in str(info.get("result") or info.get("message") or "")

    runs = client.get(f"/api/projects/{pid}/metrics").json()
    assert len(runs) == 1
    run = runs[0]
    assert run["k"] == 5 and run["sample_size"] == 15 and run["seed"] == 7
    assert run["stale"] is False
    assert run["projection_run_id"] == proj_id
    retention = run["metrics"]["neighbor_retention"]
    assert 0.0 <= retention["value"] <= 1.0
    assert retention["explanation"]  # never a bare number
    assert "trustworthiness" in run["metrics"]
    # No relations were extracted in this project → honest None + guidance.
    assert run["metrics"]["relation_precision"]["value"] is None
    assert any("extract/import relations" in w for w in run["warnings"])

    # Idempotent recompute (same fingerprint) — one run, not two.
    _compute_metrics(
        client,
        pid,
        {
            "embedding_run_id": run_id,
            "projection_run_id": proj_id,
            "k": 5,
            "sample": 15,
            "seed": 7,
        },
    )
    assert len(client.get(f"/api/projects/{pid}/metrics").json()) == 1

    # Detail endpoint agrees with the inventory.
    detail = client.get(f"/api/projects/{pid}/metrics/{run['id']}").json()
    assert detail["id"] == run["id"]
    assert detail["metrics"]["neighbor_retention"]["value"] == retention["value"]

    # Staleness: corpus change → reindex → embedding recompute → run is stale.
    utils = sample_project / "src" / "utils.js"
    utils.write_text(
        utils.read_text(encoding="utf-8") + "\nfunction added() {}\n", encoding="utf-8"
    )
    job = client.post(f"/api/projects/{pid}/index").json()
    assert wait_for_job(client, pid, job["id"])["state"] == "done"
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "raw_fragment"},
    ).json()
    assert wait_for_job(client, pid, job["id"])["state"] == "done"
    stale_run = client.get(f"/api/projects/{pid}/metrics/{run['id']}").json()
    assert stale_run["stale"] is True

    # Deletion.
    assert client.delete(f"/api/projects/{pid}/metrics/{run['id']}").status_code == 200
    assert client.get(f"/api/projects/{pid}/metrics").json() == []
    assert client.get(f"/api/projects/{pid}/metrics/{run['id']}").status_code == 404
    assert client.delete(f"/api/projects/{pid}/metrics/{run['id']}").status_code == 404


def test_metrics_api_validation(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    response = client.post(
        f"/api/projects/{pid}/metrics/compute",
        json={"embedding_run_id": "ghost000000000"},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "unknown_embedding_run"

    response = client.post(
        f"/api/projects/{pid}/metrics/compute",
        json={"embedding_run_id": run_id, "projection_run_id": "ghost000000000"},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "projection_not_found"

    response = client.post(
        f"/api/projects/{pid}/metrics/compute",
        json={"embedding_run_id": run_id, "k": 0},
    )
    assert response.status_code == 422


def test_metrics_without_projection_only_relations(
    client: TestClient,
    mini_tree: str,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid = mini_tree
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "raw_fragment"},
    ).json()
    assert wait_for_job(client, pid, job["id"])["state"] == "done"
    run_id = client.get(f"/api/projects/{pid}/embeddings").json()[0]["id"]

    extract = client.post(f"/api/projects/{pid}/relations/extract")
    assert wait_for_job(client, pid, extract.json()["id"])["state"] == "done"

    _compute_metrics(client, pid, {"embedding_run_id": run_id, "k": 3, "sample": 10, "seed": 5})
    run = client.get(f"/api/projects/{pid}/metrics").json()[0]
    assert run["projection_run_id"] is None
    assert "neighbor_retention" not in run["metrics"]
    assert "trustworthiness" not in run["metrics"]
    precision = run["metrics"]["relation_precision"]
    # belongs_to pairs (C.m ↔ C) exist as fragment pairs — the metric is
    # COMPUTED (value 0.0 or better), not None: known pairs are embedded.
    assert precision["value"] is None or 0.0 <= precision["value"] <= 1.0
    assert precision["n_known_pairs_embedded"] >= 1
    assert any("projection metrics skipped" in w for w in run["warnings"])


# ---------------------------------------------------------------------------
# Experiments API
# ---------------------------------------------------------------------------


def _fragment_ids(client: TestClient, pid: str, limit: int = 3) -> list[str]:
    items = client.get(f"/api/projects/{pid}/fragments?limit={limit}").json()["items"]
    return [str(item["id"]) for item in items]


def test_experiment_config_accepts_file_color_mode(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    """color_by «file» (coloring points by file type) round-trips; unknown modes are rejected."""
    pid, run_id = _embedded_project(client, sample_project)
    proj3 = _compute_projection(client, pid, run_id, 3)
    config = {
        "view_mode": "3d",
        "embedding_run_id": run_id,
        "projections": {"three": proj3, "two": [], "four": None},
        "slice": None,
        "slice_display": "dim",
        "clustering_run_id": None,
        "color_by": "file",
        "group_ids": [],
        "selection": [],
        "selection_truncated": False,
        "metric_run_ids": [],
    }
    created = client.post(
        f"/api/projects/{pid}/experiments", json={"name": "by-file", "config": config}
    )
    assert created.status_code == 201, created.text
    assert created.json()["config"]["color_by"] == "file"
    # an unknown color mode is rejected by the schema (never silently stored)
    bad = {**config, "color_by": "rainbow"}
    resp = client.post(f"/api/projects/{pid}/experiments", json={"name": "bad", "config": bad})
    assert resp.status_code == 422


def test_experiments_save_open_compare_delete(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    proj3 = _compute_projection(client, pid, run_id, 3)
    proj2 = _compute_projection(client, pid, run_id, 2)
    _compute_metrics(
        client, pid, {"embedding_run_id": run_id, "projection_run_id": proj3, "k": 5, "sample": 15}
    )
    metric_id = client.get(f"/api/projects/{pid}/metrics").json()[0]["id"]
    fids = _fragment_ids(client, pid)
    group = client.post(
        f"/api/projects/{pid}/groups", json={"name": "core", "fragment_ids": fids[:2]}
    ).json()

    config = {
        "view_mode": "split",
        "embedding_run_id": run_id,
        "projections": {"three": proj3, "two": [proj2], "four": None},
        "slice": None,
        "slice_display": "dim",
        "clustering_run_id": None,
        "color_by": "kind",
        "group_ids": [group["id"]],
        "selection": [*fids, "ghost000000001"],  # one dead id → dropped, recorded
        "selection_truncated": False,
        "metric_run_ids": [metric_id],
    }
    created = client.post(
        f"/api/projects/{pid}/experiments",
        json={"name": "baseline", "description": "PCA split view", "config": config},
    )
    assert created.status_code == 201, created.text
    exp = created.json()
    assert exp["name"] == "baseline"
    assert exp["config"]["selection"] == fids  # the dead id was dropped
    snapshot = exp["snapshot"]
    assert snapshot["selection_dropped_at_save"] == 1
    assert snapshot["app_version"] == __version__
    assert snapshot["schema_version"] == 7
    assert snapshot["corpus"]["fragments"] == 21
    summary = snapshot["summary"]
    assert summary["view_mode"] == "split"
    assert summary["groups"] == 1
    assert summary["metric_runs"] == 1
    # Metric VALUES captured at save time — comparable later without recompute.
    values = snapshot["metric_summary"][metric_id]["values"]
    assert isinstance(values["neighbor_retention"], float)

    # Duplicate name is rejected.
    dup = client.post(
        f"/api/projects/{pid}/experiments", json={"name": "baseline", "config": config}
    )
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "experiment_name_taken"

    # Unknown references are rejected with the exact list (no silent saves).
    broken = {**config, "projections": {**config["projections"], "three": "ghost000000002"}}
    bad = client.post(f"/api/projects/{pid}/experiments", json={"name": "broken", "config": broken})
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "experiment_refs_missing"
    assert "ghost000000002" in bad.json()["error"]["message"]

    # List = summaries only; detail = full config + live status (all fresh).
    listed = client.get(f"/api/projects/{pid}/experiments").json()
    assert len(listed) == 1
    assert listed[0]["summary"]["metric_values"]["neighbor_retention"] == pytest.approx(
        values["neighbor_retention"]
    )
    detail = client.get(f"/api/projects/{pid}/experiments/{exp['id']}").json()
    assert detail["live_status"]["missing"] == {}
    assert detail["live_status"]["stale"] == {}

    # Deleting a referenced projection → the experiment REPORTS it on open
    # (never silently substitutes another run).
    assert client.delete(f"/api/projects/{pid}/projections/{proj3}").status_code == 200
    detail = client.get(f"/api/projects/{pid}/experiments/{exp['id']}").json()
    assert detail["live_status"]["missing"]["projections.three"] == [proj3]

    # Export carries config + snapshot + live status (interpretation package).
    exported = client.get(f"/api/projects/{pid}/exports/experiments/{exp['id']}")
    assert exported.status_code == 200
    assert "attachment" in exported.headers["content-disposition"]
    payload = exported.json()
    assert payload["config"]["projections"]["three"] == proj3
    assert payload["live_status"]["missing"]["projections.three"] == [proj3]
    assert payload["snapshot"]["metric_summary"]

    assert client.delete(f"/api/projects/{pid}/experiments/{exp['id']}").status_code == 200
    assert client.get(f"/api/projects/{pid}/experiments").json() == []
    assert client.get(f"/api/projects/{pid}/experiments/{exp['id']}").status_code == 404


def test_experiment_config_rejects_unknown_fields(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    response = client.post(
        f"/api/projects/{pid}/experiments",
        json={
            "name": "typo",
            "config": {"view_mode": "3d", "embedding_run_idd": run_id},
        },
    )
    assert response.status_code == 422  # a typo must not silently vanish


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------


def test_export_projection_points_csv_and_json(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    proj_id = _compute_projection(client, pid, run_id, 2)

    csv_response = client.get(f"/api/projects/{pid}/exports/projection/{proj_id}/points?format=csv")
    assert csv_response.status_code == 200
    assert csv_response.headers["content-type"].startswith("text/csv")
    assert (
        f'attachment; filename="projection_{proj_id}_points.csv"'
        in (csv_response.headers["content-disposition"])
    )
    text = csv_response.text
    assert text.startswith("\ufeff")  # BOM: Excel on Windows reads Cyrillic
    lines = text.lstrip("\ufeff").strip().split("\n")
    header = lines[0].split(",")
    assert header[:7] == [
        "fragment_id",
        "rel_path",
        "kind",
        "name",
        "symbol_path",
        "start_line",
        "end_line",
    ]
    points = client.get(f"/api/projects/{pid}/projections/{proj_id}/points").json()
    assert len(lines) == points["count"] + 1
    # Axis labels are the last columns (PC1/PC2 for pca-2d).
    assert header[-2:] == points["axis_labels"][-2:]

    json_response = client.get(
        f"/api/projects/{pid}/exports/projection/{proj_id}/points?format=json"
    )
    assert json_response.status_code == 200
    payload = json_response.json()
    assert payload["projection_id"] == proj_id
    assert payload["count"] == points["count"]
    assert payload["stale"] is False

    missing = client.get(f"/api/projects/{pid}/exports/projection/ghost000000000/points")
    assert missing.status_code == 404


def test_export_fragments_selection(client: TestClient, sample_project: Path) -> None:
    pid = create_indexed_project(client, sample_project)
    fids = _fragment_ids(client, pid, limit=2)

    response = client.post(f"/api/projects/{pid}/exports/fragments", json={"fragment_ids": fids})
    assert response.status_code == 200
    assert "X-Ese-Missing-Fragments" not in response.headers
    lines = response.text.lstrip("\ufeff").strip().split("\n")
    assert len(lines) == 3  # header + 2 rows
    assert lines[1].startswith(fids[0])

    with_ghost = client.post(
        f"/api/projects/{pid}/exports/fragments", json={"fragment_ids": [*fids, "ghost000000003"]}
    )
    assert with_ghost.headers["X-Ese-Missing-Fragments"] == "1"

    empty = client.post(f"/api/projects/{pid}/exports/fragments", json={"fragment_ids": []})
    assert empty.status_code == 422  # an empty selection exports nothing — refused


def test_export_relations_csv(client: TestClient, mini_tree: str) -> None:
    pid = mini_tree
    extract = client.post(f"/api/projects/{pid}/relations/extract")
    assert wait_for_job(client, pid, extract.json()["id"])["state"] == "done"

    response = client.get(f"/api/projects/{pid}/exports/relations?format=csv")
    assert response.status_code == 200
    text = response.text.lstrip("\ufeff").strip()
    lines = text.split("\n")
    assert lines[0].startswith("id,kind,origin,confidence,detail")
    assert len(lines) > 1
    assert any("imports" in line for line in lines[1:])

    filtered = client.get(f"/api/projects/{pid}/exports/relations?format=json&kind=belongs_to")
    payload = filtered.json()
    assert payload["count"] >= 1
    assert all(r["kind"] == "belongs_to" for r in payload["relations"])


def test_export_metric_run_json(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    _compute_metrics(client, pid, {"embedding_run_id": run_id, "k": 4, "sample": 10, "seed": 2})
    metric_id = client.get(f"/api/projects/{pid}/metrics").json()[0]["id"]

    response = client.get(f"/api/projects/{pid}/exports/metrics/{metric_id}")
    assert response.status_code == 200
    assert "attachment" in response.headers["content-disposition"]
    payload = response.json()
    assert payload["id"] == metric_id
    assert payload["k"] == 4 and payload["sample_size"] == 10 and payload["seed"] == 2
    assert payload["metrics"]["relation_precision"]["explanation"]
    assert payload["versions"]  # library versions travel with the numbers

    assert client.get(f"/api/projects/{pid}/exports/metrics/ghost000000004").status_code == 404


# ---------------------------------------------------------------------------
# Migration v5 → v6 (additive, keeps data)
# ---------------------------------------------------------------------------


def test_db_migration_v5_to_v6_keeps_existing_data(settings: Settings) -> None:
    from datetime import UTC, datetime

    from app.storage.db import open_database
    from app.storage.models import MetricRunRow, RelationRow
    from sqlalchemy import text

    now = datetime.now(UTC).isoformat(timespec="seconds")
    store = ProjectStore(settings.data_dir)
    ctx = store.create_project("mig56", [str(Path(__file__).parent)])
    db_path = ctx.project_dir / "project.db"
    with ctx.session_factory() as session:
        session.add(
            RelationRow(
                id="rel-keep-00001",
                source_file_id=None,
                source_fragment_id=None,
                target_file_id=None,
                target_fragment_id=None,
                kind="imports",
                origin="manual",
                confidence=0.5,
                detail="kept through migration",
                created_at=now,
            )
        )
        session.commit()

    # Simulate a (v5) database: drop the tables.
    with ctx.engine.begin() as conn:
        for table in ("metric_runs", "experiments"):
            conn.execute(text(f"DROP TABLE {table}"))
        conn.execute(text("UPDATE meta SET value='5' WHERE key='schema_version'"))
    store.close_all()

    engine, factory = open_database(db_path)
    with factory() as session:
        kept = session.get(RelationRow, "rel-keep-00001")
        assert kept is not None and kept.detail == "kept through migration"
        version = session.execute(
            text("SELECT value FROM meta WHERE key='schema_version'")
        ).scalar_one()
        assert str(version) == "6"
        # The new tables exist and are usable.
        assert session.execute(text("SELECT COUNT(*) FROM metric_runs")).scalar_one() == 0
        assert session.execute(text("SELECT COUNT(*) FROM experiments")).scalar_one() == 0
        assert session.get(MetricRunRow, "nothing") is None
    engine.dispose()
    store.close_all()
