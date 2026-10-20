"""Tests: slices of the original space + semantic neighbors.

Acceptance: "корректная геометрия среза для известных синтетических векторов",
"корректный поиск соседей и метрики на малом известном наборе". The unit
tests hand-compute the expected geometry; the API tests drive the full
stack with the deterministic fake provider (no torch).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest
from app.api.schemas import ComputeSliceRequest, SliceNormalDTO
from app.config import Settings
from app.neighbor_search.search import NeighborSearchError, knn
from app.slice_engine.engine import SliceParamsError, compute_slice, resolve_normal
from fastapi.testclient import TestClient

from tests.conftest import (
    FAKE_DIM,
    FAKE_MODEL_ID,
    FakeProvider,
    create_indexed_project,
    wait_for_job,
)


def _embedded_project(client: TestClient, sample_project: Path) -> tuple[str, str]:
    """Index + embed the fixture corpus; returns (project_id, run_id)."""
    pid = create_indexed_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "raw_fragment"},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    return pid, runs[0]["id"]


# ---------------------------------------------------------------------------
# Slice geometry (synthetic, hand-computed)
# ---------------------------------------------------------------------------

SYNTH = np.array(
    [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        [10.0, 5.0, -3.0],
    ],
    dtype=np.float32,
)


def test_slice_axis_normal_geometry_exact() -> None:
    # normal = e0 → u(x) = x0 - mean(x0); mean = 13/4 = 3.25
    normal = resolve_normal("axis", 0, None, SYNTH)
    np.testing.assert_allclose(normal, [1.0, 0.0, 0.0])
    result = compute_slice(SYNTH, normal, position=-2.25, thickness=2.0)
    np.testing.assert_allclose(result.u, [-3.25, -2.25, -1.25, 6.75], atol=1e-6)
    # layer = |u + 2.25| <= 1 → u ∈ [-3.25, -1.25]; boundaries are INCLUSIVE
    assert list(result.in_layer) == [True, True, True, False]
    assert result.in_layer_count == 3


def test_slice_thickness_zero_and_full() -> None:
    normal = resolve_normal("axis", 0, None, SYNTH)
    exact = compute_slice(SYNTH, normal, position=-2.25, thickness=0.0)
    assert list(exact.in_layer) == [False, True, False, False]
    wide = compute_slice(SYNTH, normal, position=0.0, thickness=100.0)
    assert wide.in_layer_count == 4


def test_slice_vector_normal_is_normalized() -> None:
    normal = resolve_normal("vector", None, [2.0, 0.0, 0.0], SYNTH)
    np.testing.assert_allclose(normal, [1.0, 0.0, 0.0])
    with pytest.raises(SliceParamsError, match="zero"):
        resolve_normal("vector", None, [0.0, 0.0, 0.0], SYNTH)
    with pytest.raises(SliceParamsError, match="expected 3"):
        resolve_normal("vector", None, [1.0, 0.0], SYNTH)


def test_slice_pca_normal_is_a_principal_direction() -> None:
    # data along a line + noise: PC1 follows the dominant direction
    data = np.array([[t, 2 * t, 0.0] for t in range(10)] + [[0.1, -0.2, 0.05]], dtype=np.float32)
    normal = resolve_normal("pca", 0, None, data)
    assert abs(float(np.linalg.norm(normal)) - 1.0) < 1e-9
    # PC1 is (nearly) parallel to (1, 2, 0)/sqrt(5)
    expected = np.array([1.0, 2.0, 0.0]) / math.sqrt(5)
    assert abs(float(normal @ expected)) > 0.99
    # PCA directions are mutually orthogonal
    second = resolve_normal("pca", 1, None, data)
    assert abs(float(normal @ second)) < 1e-6


def test_slice_guards() -> None:
    with pytest.raises(SliceParamsError, match="out of range"):
        resolve_normal("axis", 99, None, SYNTH)
    with pytest.raises(SliceParamsError, match="requires a non-negative index"):
        resolve_normal("axis", None, None, SYNTH)
    with pytest.raises(SliceParamsError, match="unknown normal kind"):
        resolve_normal("wavelet", 0, None, SYNTH)
    normal = resolve_normal("axis", 0, None, SYNTH)
    with pytest.raises(SliceParamsError, match="negative"):
        compute_slice(SYNTH, normal, 0.0, -1.0)
    with pytest.raises(SliceParamsError, match="does not match"):
        compute_slice(SYNTH, np.array([1.0, 0.0]), 0.0, 1.0)
    with pytest.raises(SliceParamsError, match="non-empty"):
        compute_slice(np.zeros((0, 3), dtype=np.float32), normal, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Slice API
# ---------------------------------------------------------------------------


def test_slice_api_flow(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    # A wide layer covers everything; the note keeps the interpretation honest.
    response = client.post(
        f"/api/projects/{pid}/slices/compute",
        json={
            "embedding_run_id": run_id,
            "normal": {"kind": "axis", "index": 0},
            "position": 0.0,
            "thickness": 1e6,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 21
    assert body["in_layer"] == 21
    assert body["dim"] == FAKE_DIM
    assert len(body["ids"]) == 21 and len(body["u"]) == 21
    assert "ИСХОДНОМ" in body["note"] and "clipping" in body["note"]
    assert body["u_min"] <= body["u_max"]

    # Client-side membership from the SERVED (rounded) u always agrees with
    # the reported count — no boundary drift between backend and views.
    half = 0.05 / 2
    narrow = client.post(
        f"/api/projects/{pid}/slices/compute",
        json={
            "embedding_run_id": run_id,
            "normal": {"kind": "pca", "index": 1},
            "position": 0.0,
            "thickness": 0.05,
        },
    ).json()
    recount = sum(1 for x in narrow["u"] if abs(x - 0.0) <= half)
    assert narrow["in_layer"] == recount
    assert narrow["in_layer"] < narrow["total"]  # a real layer, not everything

    # Bad input is rejected with an actionable error.
    bad = client.post(
        f"/api/projects/{pid}/slices/compute",
        json={
            "embedding_run_id": run_id,
            "normal": {"kind": "axis", "index": FAKE_DIM + 5},
        },
    )
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "invalid_slice_params"
    unknown = client.post(
        f"/api/projects/{pid}/slices/compute",
        json={"embedding_run_id": "deadbeef", "normal": {"kind": "axis", "index": 0}},
    )
    assert unknown.status_code == 404


def test_saved_slices_roundtrip(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    created = client.post(
        f"/api/projects/{pid}/slices",
        json={
            "name": "PC2 layer",
            "embedding_run_id": run_id,
            "normal": {"kind": "pca", "index": 1},
            "position": 0.1,
            "thickness": 0.2,
        },
    )
    assert created.status_code == 201, created.text
    saved = created.json()
    assert saved["normal_kind"] == "pca" and saved["normal_index"] == 1
    vector = saved["vector"]
    assert len(vector) == FAKE_DIM
    assert abs(math.sqrt(sum(v * v for v in vector)) - 1.0) < 1e-6

    # Duplicate names are refused (like presets).
    dup = client.post(
        f"/api/projects/{pid}/slices",
        json={
            "name": "PC2 layer",
            "embedding_run_id": run_id,
            "normal": {"kind": "pca", "index": 1},
        },
    )
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "slice_name_taken"

    # Computing from the RESOLVED vector gives the same layer as kind+index.
    via_vector = client.post(
        f"/api/projects/{pid}/slices/compute",
        json={
            "embedding_run_id": run_id,
            "normal": {"kind": "vector", "vector": vector},
            "position": 0.1,
            "thickness": 0.2,
        },
    ).json()
    via_spec = client.post(
        f"/api/projects/{pid}/slices/compute",
        json={
            "embedding_run_id": run_id,
            "normal": {"kind": "pca", "index": 1},
            "position": 0.1,
            "thickness": 0.2,
        },
    ).json()
    assert via_vector["in_layer"] == via_spec["in_layer"]
    np.testing.assert_allclose(via_vector["u"], via_spec["u"], atol=1e-5)

    listed = client.get(f"/api/projects/{pid}/slices").json()
    assert [s["name"] for s in listed] == ["PC2 layer"]
    deleted = client.delete(f"/api/projects/{pid}/slices/{saved['id']}")
    assert deleted.status_code == 200
    assert client.delete(f"/api/projects/{pid}/slices/{saved['id']}").status_code == 404


def test_slice_request_schema_bounds() -> None:
    # pydantic-level guards (thickness can never be negative in a request)
    with pytest.raises(ValueError):
        ComputeSliceRequest(
            embedding_run_id="r",
            normal=SliceNormalDTO(kind="axis", index=0),
            thickness=-1.0,
        )


# ---------------------------------------------------------------------------
# Neighbor search (hand-computed sets)
# ---------------------------------------------------------------------------


def test_knn_cosine_exact_order_and_scores() -> None:
    vectors = np.array(
        [
            [1.0, 0.0],  # 0: query
            [0.6, 0.8],  # 1: sim 0.6
            [0.0, 1.0],  # 2: sim 0.0
            [-1.0, 0.0],  # 3: sim -1.0
        ],
        dtype=np.float32,
    )
    hits = knn(vectors, query_index=0, k=5, metric="cosine")
    assert [h.index for h in hits] == [1, 2, 3]  # self excluded
    np.testing.assert_allclose([h.score for h in hits], [0.6, 0.0, -1.0], atol=1e-5)
    np.testing.assert_allclose([h.distance for h in hits], [0.4, 1.0, 2.0], atol=1e-5)


def test_knn_euclidean_and_k_limit() -> None:
    vectors = np.array([[0.0, 0.0], [3.0, 4.0], [1.0, 0.0], [0.0, 2.0]], dtype=np.float32)
    hits = knn(vectors, query_index=0, k=2, metric="euclidean")
    assert [h.index for h in hits] == [2, 3]
    np.testing.assert_allclose([h.distance for h in hits], [1.0, 2.0], atol=1e-5)
    np.testing.assert_allclose([h.score for h in hits], [-1.0, -2.0], atol=1e-5)
    # k beyond the corpus returns everything except self
    assert len(knn(vectors, 0, k=99, metric="euclidean")) == 3


def test_knn_guards() -> None:
    vectors = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
    with pytest.raises(NeighborSearchError, match="metric"):
        knn(vectors, 0, 1, "manhattan")
    with pytest.raises(NeighborSearchError, match="k must be"):
        knn(vectors, 0, 0, "cosine")
    with pytest.raises(NeighborSearchError, match="out of range"):
        knn(vectors, 9, 1, "cosine")
    zero = np.array([[0.0, 0.0], [1.0, 0.0]], dtype=np.float32)
    with pytest.raises(NeighborSearchError, match="zero norm"):
        knn(zero, 0, 1, "cosine")


# ---------------------------------------------------------------------------
# Neighbors API
# ---------------------------------------------------------------------------


def test_neighbors_api_flow(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    fragments = client.get(f"/api/projects/{pid}/fragments?limit=5").json()["items"]
    target = fragments[0]

    body = client.post(
        f"/api/projects/{pid}/neighbors",
        json={"fragment_id": target["id"], "k": 5, "metric": "cosine"},
    )
    assert body.status_code == 200, body.text
    data = body.json()
    assert data["embedding_run_id"] == run_id
    assert data["metric"] == "cosine" and data["k"] == 5
    assert data["total_vectors"] == 21
    assert 1 <= len(data["neighbors"]) <= 5
    assert all(n["fragment_id"] != target["id"] for n in data["neighbors"])
    scores = [n["score"] for n in data["neighbors"]]
    assert scores == sorted(scores, reverse=True), "ranking must be honest"
    for n in data["neighbors"]:
        assert n["rel_path"] and n["start_line"] >= 1 and n["end_line"] >= n["start_line"]
        assert abs(n["distance"] - (1.0 - n["score"])) < 1e-4
    # the note states the space the similarity was computed in
    assert "ИСХОДНЫМ" in data["note"] and "cosine" in data["note"]

    euclid = client.post(
        f"/api/projects/{pid}/neighbors",
        json={"fragment_id": target["id"], "k": 3, "metric": "euclidean"},
    ).json()
    for n in euclid["neighbors"]:
        assert abs(n["score"] + n["distance"]) < 1e-4

    missing = client.post(f"/api/projects/{pid}/neighbors", json={"fragment_id": "nonexistent0000"})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "fragment_not_found"


def test_neighbors_requires_embeddings(client: TestClient, sample_project: Path) -> None:
    pid = create_indexed_project(client, sample_project)
    fragments = client.get(f"/api/projects/{pid}/fragments?limit=1").json()["items"]
    response = client.post(
        f"/api/projects/{pid}/neighbors", json={"fragment_id": fragments[0]["id"]}
    )
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "no_embedding_run"
    assert "EXPERIMENTS" in str(error["hint"])


def test_neighbors_refill_and_report_stale_vectors(
    client: TestClient,
    settings: Settings,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    """Audit #10: a vector whose fragment row is gone must never silently
    shorten the list — the answer is refilled and the drop is reported."""
    import sqlite3

    pid, _run_id = _embedded_project(client, sample_project)
    fragments = client.get(f"/api/projects/{pid}/fragments?limit=5").json()["items"]
    target = fragments[0]

    first = client.post(
        f"/api/projects/{pid}/neighbors",
        json={"fragment_id": target["id"], "k": 5, "metric": "cosine"},
    ).json()
    assert first["dropped_stale"] == 0
    assert len(first["neighbors"]) == 5
    victim = first["neighbors"][0]["fragment_id"]

    # delete the fragment ROW behind the cache's back (the vector survives —
    # exactly the transient state the audit describes; a reindex would prune it)
    db_path = settings.data_dir / "projects" / pid / "project.db"
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("DELETE FROM fragments WHERE id = ?", (victim,))
        conn.commit()
    finally:
        conn.close()

    second = client.post(
        f"/api/projects/{pid}/neighbors",
        json={"fragment_id": target["id"], "k": 5, "metric": "cosine"},
    ).json()
    assert second["dropped_stale"] >= 1
    assert len(second["neighbors"]) == 5  # refilled from the margin
    assert all(n["fragment_id"] != victim for n in second["neighbors"])
    # the note tells the user what happened — never a silent short list
    assert "Исключено устаревших векторов" in second["note"]
