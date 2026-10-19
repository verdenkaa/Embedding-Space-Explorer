"""projection tests.

Unit tests cover the mathematics on known synthetic vectors,
cache/fingerprint rules and validation. API tests drive the full flow with
the shared fake embedding provider: index → embed → project → points →
staleness after reindex → recompute. UMAP is exercised on small data with a
fixed seed (deterministic; the first fit pays the numba JIT warm-up once).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from app.config import Settings
from app.embedding_providers.base import ModelInfo
from app.projection_methods.base import (
    ProjectionParamsError,
    UnknownProjectionMethodError,
    normalize_components,
    projection_fingerprint,
)
from app.projection_methods.cache import ProjectionCache
from app.projection_methods.pca_method import PcaMethod
from app.projection_methods.registry import get_method, require_method
from app.projection_methods.umap_method import UmapMethod
from app.storage.models import EmbeddingRunRow
from app.storage.projects_store import ProjectStore
from app.vector_store.npz_cache import NpzEmbeddingCache
from fastapi.testclient import TestClient

from tests.conftest import (
    FAKE_DIM,
    FAKE_MODEL_ID,
    FakeProvider,
    create_indexed_project,
    wait_for_job,
)

# ---------------------------------------------------------------------------
# PCA mathematics on known synthetic vectors
# ---------------------------------------------------------------------------


def _line_data(n: int = 20, dim: int = 8, seed: int = 7) -> np.ndarray:
    """Points exactly on a line: PC1 must capture ~100% of the variance and
    PC2+ must be ~0 (known geometry)."""
    rng = np.random.default_rng(seed)
    direction = rng.normal(size=dim)
    direction /= np.linalg.norm(direction)
    t = np.linspace(-3.0, 3.0, n)[:, None]
    return (t * direction[None, :]).astype(np.float32)


def test_pca_collinear_data_geometry() -> None:
    data = _line_data()
    result = PcaMethod().fit(data, n_components=3, params={"whiten": False}, seed=42)
    assert result.coords.shape == (20, 3)
    assert result.coords.dtype == np.float32
    assert result.axis_labels == ("PC1", "PC2", "PC3")
    ratios = result.axis_info
    assert ratios is not None
    assert ratios[0] == pytest.approx(1.0, abs=1e-4)
    assert ratios[1] == pytest.approx(0.0, abs=1e-4)
    # PC1 coordinates follow the line parameter; later components are dust.
    assert np.max(np.abs(result.coords[:, 0])) > 1.0
    assert np.max(np.abs(result.coords[:, 1])) == pytest.approx(0.0, abs=1e-4)


def test_pca_is_deterministic_without_seed() -> None:
    rng = np.random.default_rng(1)
    data = rng.normal(size=(30, 8)).astype(np.float32)
    a = PcaMethod().fit(data, n_components=3, params={}, seed=42)
    b = PcaMethod().fit(data, n_components=3, params={}, seed=99)
    # Same data + params → identical coordinates (seed does not influence PCA).
    np.testing.assert_array_equal(a.coords, b.coords)


def test_pca_ratios_sorted_and_bounded() -> None:
    rng = np.random.default_rng(2)
    data = rng.normal(size=(40, 8)).astype(np.float32)
    result = PcaMethod().fit(data, n_components=3, params={}, seed=42)
    ratios = result.axis_info
    assert ratios is not None
    assert list(ratios) == sorted(ratios, reverse=True)
    assert 0.0 <= sum(ratios) <= 1.0 + 1e-6
    assert all(0.0 <= r <= 1.0 for r in ratios)


def test_pca_identical_vectors_degenerate_but_honest() -> None:
    data = np.ones((5, 8), dtype=np.float32)
    result = PcaMethod().fit(data, n_components=2, params={}, seed=42)
    ratios = result.axis_info
    assert ratios is not None
    assert not any(np.isnan(r) for r in ratios)  # zeros, not NaN


def test_pca_guards() -> None:
    method = PcaMethod()
    with pytest.raises(ProjectionParamsError, match="at least 2 vectors"):
        method.fit(np.zeros((1, 8), dtype=np.float32), n_components=2, params={}, seed=0)
    with pytest.raises(ProjectionParamsError, match="exceeds"):
        method.fit(np.zeros((3, 8), dtype=np.float32), n_components=4, params={}, seed=0)
    # 3 samples, 8 dims → min is 3 → n_components=3 is allowed
    result = method.fit(
        np.random.default_rng(3).normal(size=(3, 8)).astype(np.float32),
        n_components=3,
        params={},
        seed=0,
    )
    assert result.coords.shape == (3, 3)


# ---------------------------------------------------------------------------
# UMAP (small data, fixed seed → deterministic)
# ---------------------------------------------------------------------------


def test_umap_deterministic_with_seed() -> None:
    rng = np.random.default_rng(5)
    data = rng.normal(size=(30, 8)).astype(np.float32)
    method = UmapMethod()
    if not method.is_available():  # pragma: no cover - umap is a pinned dep
        pytest.skip("umap-learn not installed")
    params = method.validate_params({"n_neighbors": 5, "min_dist": 0.1, "metric": "cosine"})
    a = method.fit(data, n_components=2, params=params, seed=123)
    b = method.fit(data, n_components=2, params=params, seed=123)
    assert a.coords.shape == (30, 2)
    assert a.axis_labels == ("UMAP1", "UMAP2")
    assert a.axis_info is None
    np.testing.assert_allclose(a.coords, b.coords, rtol=1e-5, atol=1e-6)
    # A different seed gives a different (but equally valid) layout.
    c = method.fit(data, n_components=2, params=params, seed=777)
    assert not np.allclose(a.coords, c.coords)


def test_umap_guards() -> None:
    method = UmapMethod()
    with pytest.raises(ProjectionParamsError, match="at least 3 vectors"):
        method.fit(np.zeros((2, 8), dtype=np.float32), n_components=2, params={}, seed=0)
    with pytest.raises(ProjectionParamsError, match="n_neighbors"):
        method.fit(
            np.zeros((10, 8), dtype=np.float32),
            n_components=2,
            params={"n_neighbors": 15, "min_dist": 0.1, "metric": "cosine"},
            seed=0,
        )


# ---------------------------------------------------------------------------
# Parameter validation, fingerprints, components
# ---------------------------------------------------------------------------


def test_validate_params_defaults_and_errors() -> None:
    umap = UmapMethod()
    normalized = umap.validate_params({})
    assert normalized == {"n_neighbors": 15, "min_dist": 0.1, "metric": "cosine"}
    # int-valued float is coerced; fractional is rejected
    assert umap.validate_params({"n_neighbors": 7.0})["n_neighbors"] == 7
    with pytest.raises(ProjectionParamsError, match="integer"):
        umap.validate_params({"n_neighbors": 7.5})
    with pytest.raises(ProjectionParamsError, match=">="):
        umap.validate_params({"n_neighbors": 1})
    with pytest.raises(ProjectionParamsError, match="<="):
        umap.validate_params({"n_neighbors": 501})
    with pytest.raises(ProjectionParamsError, match="one of"):
        umap.validate_params({"metric": "manhattan"})
    with pytest.raises(ProjectionParamsError, match="unknown parameter"):
        umap.validate_params({"nope": 1})
    with pytest.raises(ProjectionParamsError, match="boolean"):
        PcaMethod().validate_params({"whiten": "yes"})


def test_projection_fingerprint_sensitivity() -> None:
    base = projection_fingerprint("emb1", "pca", 3, {"whiten": False}, 42)
    assert base == projection_fingerprint("emb1", "pca", 3, {"whiten": False}, 42)
    assert base != projection_fingerprint("emb2", "pca", 3, {"whiten": False}, 42)
    assert base != projection_fingerprint("emb1", "umap", 3, {"whiten": False}, 42)
    assert base != projection_fingerprint("emb1", "pca", 2, {"whiten": False}, 42)
    assert base != projection_fingerprint("emb1", "pca", 3, {"whiten": True}, 42)
    assert base != projection_fingerprint("emb1", "pca", 3, {"whiten": False}, 43)


def test_normalize_components() -> None:
    assert normalize_components([]) == [3, 2]
    assert normalize_components([2, 2]) == [2]
    assert normalize_components([2, 3]) == [2, 3]
    # 4 feeds the 4D view (3D scene + "time" slider over the 4th axis)
    assert normalize_components([4]) == [4]
    assert normalize_components([4, 4]) == [4]
    with pytest.raises(ProjectionParamsError):
        normalize_components([5])


def test_registry_lookup() -> None:
    assert get_method("pca") is not None
    assert get_method("nope") is None
    with pytest.raises(UnknownProjectionMethodError):
        require_method("nope")


# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------


def test_projection_cache_roundtrip_and_damage(tmp_path: Path) -> None:
    path = tmp_path / "proj.npz"
    assert ProjectionCache.load(path) is None  # absent

    coords = np.arange(12, dtype=np.float32).reshape(4, 3)
    cache = ProjectionCache(
        path=path,
        ids=["a", "b", "c", "d"],
        coords=coords,
        axis_info=np.array([0.7, 0.2, 0.1], dtype=np.float32),
    )
    cache.save()
    loaded = ProjectionCache.load(path)
    assert loaded is not None
    assert loaded.ids == ["a", "b", "c", "d"]
    assert loaded.n_components == 3
    np.testing.assert_allclose(loaded.coords, coords)
    assert loaded.axis_info is not None
    np.testing.assert_allclose(loaded.axis_info, [0.7, 0.2, 0.1], atol=1e-6)

    path.write_bytes(b"definitely not an npz archive")
    assert ProjectionCache.load(path) is None  # damaged ≠ empty cloud


def test_embedding_signature_tracks_content(tmp_path: Path) -> None:
    path = tmp_path / "run.npz"
    cache = NpzEmbeddingCache.load(path)
    vecs = np.eye(3, 4, dtype=np.float32)
    cache.upsert(["a", "b", "c"], ["ha", "hb", "hc"], ["fa", "fb", "fc"], vecs)
    sig = cache.signature()
    cache.save()

    reloaded = NpzEmbeddingCache.load(path)
    assert reloaded is not None
    assert reloaded.signature() == sig  # stable across save/load

    reloaded.upsert(["d"], ["hd"], ["fd"], np.ones((1, 4), dtype=np.float32))
    changed = reloaded.signature()
    assert changed != sig  # added vector → dependents stale

    # Prune drops "d" (content changed) → the cache is EXACTLY the original
    # set again → the signature must return to `sig` (no false staleness for
    # projections computed before the upsert).
    reloaded.prune({"a": "fa", "b": "fb", "c": "fc", "d": "fd-CHANGED"})
    assert len(reloaded) == 3
    assert reloaded.signature() == sig


# ---------------------------------------------------------------------------
# API: catalog
# ---------------------------------------------------------------------------


def test_methods_catalog(client: TestClient) -> None:
    response = client.get("/api/projections/methods")
    assert response.status_code == 200
    methods = {m["method_id"]: m for m in response.json()}
    assert set(methods) == {"pca", "umap", "raw_axes"}

    pca = methods["pca"]
    assert pca["available"] is True
    assert pca["supported_components"] == [2, 3, 4]
    assert pca["caveat"]  # honest interpretation note is present
    assert "ТЗ" not in pca["caveat"]  # user-facing text without spec references
    assert {p["name"] for p in pca["params"]} == {"whiten"}

    umap = methods["umap"]
    spec = {p["name"]: p for p in umap["params"]}
    assert set(spec) == {"n_neighbors", "min_dist", "metric"}
    assert spec["n_neighbors"]["type"] == "int"
    assert spec["n_neighbors"]["default"] == 15
    assert spec["metric"]["choices"] == ["cosine", "euclidean"]
    assert "искажает расстояния" in umap["caveat"]
    assert "ТЗ" not in umap["caveat"]  # user-facing text without spec references

    raw = methods["raw_axes"]
    assert raw["available"] is True
    raw_spec = {p["name"]: p for p in raw["params"]}
    assert set(raw_spec) == {"axes", "standardize"}
    assert raw_spec["axes"]["type"] == "int_list"
    assert raw_spec["axes"]["min_items"] == 2
    assert raw_spec["axes"]["max_items"] == 4
    # honest labeling: model dimensions have no human semantics (TZ 5.1)
    assert "не имеют" in raw["description"]
    assert "ТЗ" not in raw["description"]
    assert "игнорируются" in raw["caveat"]


# ---------------------------------------------------------------------------
# API: full projection flow with the fake provider
# ---------------------------------------------------------------------------


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
    assert len(runs) == 1 and runs[0]["count"] == 21
    return pid, runs[0]["id"]


def test_projection_flow_pca(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    # Compute default components [3, 2] in one job.
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "seed": 42},
    )
    assert job.status_code == 202, job.text
    info = wait_for_job(client, pid, job.json()["id"])
    assert info["state"] == "done", info
    assert "PCA-3D" in str(info["message"]) and "PCA-2D" in str(info["message"])

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert len(inventory) == 2
    by_nc = {r["n_components"]: r for r in inventory}
    assert set(by_nc) == {2, 3}
    for run in inventory:
        assert run["method"] == "pca"
        assert run["method_display_name"] == "PCA"
        assert run["embedding_run_id"] == run_id
        assert run["stale"] is False
        assert run["cache_ok"] is True
        assert run["count"] == 21
        assert run["seed"] == 42
        assert run["versions"].get("numpy")
        assert run["versions"].get("scikit-learn")
    assert by_nc[3]["axis_labels"] == ["PC1", "PC2", "PC3"]
    ratios = by_nc[3]["axis_info"]
    assert ratios is not None and len(ratios) == 3
    assert sum(ratios) <= 1.0 + 1e-6

    # Points: full traceability metadata, coordinates of the right dimension.
    points = client.get(f"/api/projects/{pid}/projections/{by_nc[3]['id']}/points").json()
    assert points["count"] == 21
    assert points["dropped_orphans"] == 0
    assert points["stale"] is False
    assert points["axis_labels"] == ["PC1", "PC2", "PC3"]
    for point in points["points"]:
        assert len(point["coords"]) == 3
        assert all(np.isfinite(c) for c in point["coords"])
        assert point["rel_path"] and point["symbol_path"]
        assert point["start_line"] >= 1 and point["end_line"] >= point["start_line"]

    # Cross-check one point against the corpus API (traceability contract):
    # point → fragment → file and lines.
    sample = points["points"][0]
    frag = client.get(f"/api/projects/{pid}/fragments/{sample['fragment_id']}").json()
    assert frag["rel_path"] == sample["rel_path"]
    assert frag["start_line"] == sample["start_line"]
    assert frag["end_line"] == sample["end_line"]
    assert frag["symbol_path"] == sample["symbol_path"]

    # 2D map of the same job serves 2-component coordinates.
    points2d = client.get(f"/api/projects/{pid}/projections/{by_nc[2]['id']}/points").json()
    assert points2d["count"] == 21
    assert all(len(p["coords"]) == 2 for p in points2d["points"])
    # PCA nesting: the XY of the 3D run equals the standalone 2D run.
    coords3d = {p["fragment_id"]: p["coords"] for p in points["points"]}
    for p in points2d["points"]:
        assert p["coords"] == pytest.approx(coords3d[p["fragment_id"]][:2], abs=1e-5)

    # Recompute with identical config = same fingerprints, no duplicates.
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "seed": 42},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
    assert len(client.get(f"/api/projects/{pid}/projections").json()) == 2

    # A different seed is a different run (explicit, never mixed).
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "seed": 7},
    ).json()
    wait_for_job(client, pid, job["id"])
    assert len(client.get(f"/api/projects/{pid}/projections").json()) == 4


def test_projection_flow_umap_2d(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "umap",
            "components": [2],
            "params": {"n_neighbors": 5, "min_dist": 0.1, "metric": "cosine"},
            "seed": 11,
        },
    )
    assert job.status_code == 202, job.text
    info = wait_for_job(client, pid, job.json()["id"], timeout=180)
    assert info["state"] == "done", info

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert len(inventory) == 1
    run = inventory[0]
    assert run["method"] == "umap" and run["n_components"] == 2
    assert run["axis_labels"] == ["UMAP1", "UMAP2"]
    assert run["axis_info"] is None
    assert run["params"] == {"n_neighbors": 5, "min_dist": 0.1, "metric": "cosine"}
    assert run["versions"].get("umap-learn")
    assert run["stale"] is False

    points = client.get(f"/api/projects/{pid}/projections/{run['id']}/points").json()
    assert points["count"] == 21
    assert all(len(p["coords"]) == 2 for p in points["points"])
    assert all(np.isfinite(c) for p in points["points"] for c in p["coords"])


def test_projection_stale_after_reindex_and_recompute(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [3]},
    ).json()
    wait_for_job(client, pid, job["id"])
    proj_id = client.get(f"/api/projects/{pid}/projections").json()[0]["id"]

    # Modify one file and delete another → reindex prunes vectors.
    utils = sample_project / "src" / "utils.js"
    utils.write_text(
        utils.read_text(encoding="utf-8") + "\nfunction added() {}\n", encoding="utf-8"
    )
    (sample_project / "web" / "types.ts").unlink()
    job = client.post(f"/api/projects/{pid}/index").json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info

    # Projection is now STALE (vectors changed) — inventory says so honestly.
    run = client.get(f"/api/projects/{pid}/projections").json()[0]
    assert run["id"] == proj_id
    assert run["stale"] is True
    assert run["cache_ok"] is True

    # Points still served (with a stale flag) minus orphans of removed
    # fragments — the map never shows ghosts.
    points = client.get(f"/api/projects/{pid}/projections/{proj_id}/points").json()
    assert points["stale"] is True
    assert points["dropped_orphans"] > 0
    assert points["count"] == 21 - points["dropped_orphans"]

    # Recompute embeddings, then the projection → fresh again, full coverage.
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "raw_fragment"},
    ).json()
    wait_for_job(client, pid, job["id"])
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [3]},
    ).json()
    wait_for_job(client, pid, job["id"])
    run = client.get(f"/api/projects/{pid}/projections").json()[0]
    assert run["stale"] is False
    coverage = client.get(f"/api/projects/{pid}/embeddings").json()[0]["coverage"]
    assert run["count"] == coverage["fragments_total"]
    points = client.get(f"/api/projects/{pid}/projections/{proj_id}/points").json()
    assert points["dropped_orphans"] == 0
    assert points["count"] == coverage["fragments_total"]


def test_projection_validation_errors(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    base = f"/api/projects/{pid}/projections/compute"

    unknown_method = client.post(base, json={"embedding_run_id": run_id, "method": "tsne"})
    assert unknown_method.status_code == 404
    assert unknown_method.json()["error"]["code"] == "unknown_projection_method"
    assert "/api/projections/methods" in str(unknown_method.json()["error"]["hint"])

    unknown_run = client.post(base, json={"embedding_run_id": "deadbeefdeadbeef", "method": "pca"})
    assert unknown_run.status_code == 404
    assert unknown_run.json()["error"]["code"] == "unknown_embedding_run"

    bad_params = client.post(
        base,
        json={"embedding_run_id": run_id, "method": "umap", "params": {"n_neighbors": 9999}},
    )
    assert bad_params.status_code == 400
    assert bad_params.json()["error"]["code"] == "invalid_projection_params"

    typo_params = client.post(
        base,
        json={"embedding_run_id": run_id, "method": "pca", "params": {"whitenn": True}},
    )
    assert typo_params.status_code == 400

    bad_components = client.post(
        base, json={"embedding_run_id": run_id, "method": "pca", "components": [5]}
    )
    assert bad_components.status_code == 422

    bad_seed = client.post(base, json={"embedding_run_id": run_id, "method": "pca", "seed": -1})
    assert bad_seed.status_code == 422


def test_projection_points_errors(
    client: TestClient,
    sample_project: Path,
    settings: Settings,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    missing = client.get(f"/api/projects/{pid}/projections/nosuchprojection/points")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "projection_not_found"

    # Compute, then corrupt the coordinate cache → explicit 409 instead of an
    # empty cloud served as a result.
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [2]},
    ).json()
    wait_for_job(client, pid, job["id"])
    run = client.get(f"/api/projects/{pid}/projections").json()[0]

    npz_path = settings.data_dir / "projects" / pid / "cache" / "projections" / f"{run['id']}.npz"
    assert npz_path.exists()
    npz_path.write_bytes(b"corrupted")

    damaged = client.get(f"/api/projects/{pid}/projections/{run['id']}/points")
    assert damaged.status_code == 409
    assert damaged.json()["error"]["code"] == "projection_cache_unavailable"
    assert "Recompute" in str(damaged.json()["error"]["hint"])

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert inventory[0]["cache_ok"] is False


def test_projection_no_vectors_409(
    client: TestClient, sample_project: Path, settings: Settings
) -> None:
    """An embedding run WITHOUT vectors must be rejected before queueing."""
    pid = create_indexed_project(client, sample_project)

    # Deterministic setup: insert an empty run row directly (a real one is
    # created by a compute job before the first batch — same observable state).
    store = ProjectStore(settings.data_dir)
    ctx = store.open(pid)
    with ctx.session_factory() as session:
        session.add(
            EmbeddingRunRow(
                id="emptyrun00000001",
                model_id=FAKE_MODEL_ID,
                dim=0,
                mode="raw_fragment",
                template="",
                params_json="{}",
                npz_relpath="cache/embeddings/emptyrun00000001.npz",
                count=0,
                created_at="2026-01-01T00:00:00+00:00",
                updated_at="2026-01-01T00:00:00+00:00",
            )
        )
        session.commit()

    response = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": "emptyrun00000001", "method": "pca", "components": [2]},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "no_vectors"
    assert "Compute embeddings first" in str(response.json()["error"]["hint"])


def test_projection_rejected_while_embedding_runs(
    client: TestClient, sample_project: Path, fake_provider_factory: dict[str, FakeProvider]
) -> None:
    """Projection must not race an active embed job (coordinates over
    vectors mid-flight are meaningless)."""
    pid, run_id = _embedded_project(client, sample_project)

    # Swap in a slow provider and start a SECOND run (context mode) so the
    # first run keeps count=21 while an embed job is active.
    fake_provider_factory[FAKE_MODEL_ID] = FakeProvider(
        ModelInfo(FAKE_MODEL_ID, "all-MiniLM-L6-v2", FAKE_DIM, 1, "fake"), slow=True
    )
    embed_job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "context_enriched", "batch_size": 1},
    ).json()

    response = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca"},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "projection_job_active"

    client.post(f"/api/projects/{pid}/jobs/{embed_job['id']}/cancel")
    info = wait_for_job(client, pid, embed_job["id"], timeout=30)
    assert info["state"] == "cancelled"

    # After the job is gone, compute proceeds normally.
    response = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [2]},
    )
    assert response.status_code == 202
    wait_for_job(client, pid, response.json()["id"])


def test_projection_job_is_observable(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "pca",
            "components": [2],
            "params": {"whiten": True},
            "seed": 5,
        },
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done"
    assert info["kind"] == "projection"

    listed = client.get(f"/api/projects/{pid}/jobs").json()
    assert any(j["id"] == job["id"] and j["kind"] == "projection" for j in listed)

    run = client.get(f"/api/projects/{pid}/projections").json()[0]
    assert run["params"] == {"whiten": True}
    assert run["seed"] == 5
    assert json.dumps(run["params"], sort_keys=True)  # serializable as stored


# ---------------------------------------------------------------------------
# Real model integration (opt-in: pytest -m real_model)
# ---------------------------------------------------------------------------


@pytest.mark.real_model
def test_real_model_projection_e2e(
    client: TestClient, sample_project: Path, settings: Settings
) -> None:
    """acceptance on REAL data: model → embeddings → PCA/UMAP →
    points; served coordinates are recomputed from the stored .npz vectors
    and must match (proves the map is built from saved embeddings, not
    fabricated). Downloads ~90 MB of weights on first run.
    """
    from app.embedding_providers.registry import create_provider

    provider = create_provider(FAKE_MODEL_ID, settings.data_dir)
    if not provider.is_downloaded():
        provider.download()

    pid = create_indexed_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "raw_fragment", "batch_size": 8},
    ).json()
    info = wait_for_job(client, pid, job["id"], timeout=600)
    assert info["state"] == "done", info
    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    assert runs[0]["coverage"]["embedded"] == 21
    run_id = runs[0]["id"]
    assert runs[0]["dim"] == 384

    # PCA over the real vectors.
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca"},
    ).json()
    info = wait_for_job(client, pid, job["id"], timeout=300)
    assert info["state"] == "done", info

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    by_nc = {r["n_components"]: r for r in inventory}
    assert set(by_nc) == {2, 3}
    assert all(not r["stale"] for r in inventory)

    points = client.get(f"/api/projects/{pid}/projections/{by_nc[3]['id']}/points").json()
    assert points["count"] == 21

    # Independently recompute PCA from the vectors stored on disk and
    # compare against what the API served (JSON rounding 1e-6 aside).
    from sklearn.decomposition import PCA

    emb_npz = settings.data_dir / "projects" / pid / "cache" / "embeddings" / f"{run_id}.npz"
    cache = NpzEmbeddingCache.load(emb_npz)
    assert cache is not None and len(cache) == 21
    pca = PCA(n_components=3, svd_solver="full")
    expected = pca.fit_transform(cache.vectors)
    order = {fid: i for i, fid in enumerate(cache.ids)}
    ratios = points["axis_info"]
    assert ratios is not None
    np.testing.assert_allclose(ratios, list(pca.explained_variance_ratio_), atol=1e-5)
    for point in points["points"]:
        row = expected[order[point["fragment_id"]]]
        np.testing.assert_allclose(point["coords"], row, atol=1e-4)

    # UMAP-2D over the same real vectors (seeded → deterministic).
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "umap",
            "components": [2],
            "params": {"n_neighbors": 5},
            "seed": 42,
        },
    ).json()
    info = wait_for_job(client, pid, job["id"], timeout=600)
    assert info["state"] == "done", info
    umap_runs = [
        r for r in client.get(f"/api/projects/{pid}/projections").json() if r["method"] == "umap"
    ]
    assert len(umap_runs) == 1
    pts = client.get(f"/api/projects/{pid}/projections/{umap_runs[0]['id']}/points").json()
    assert pts["count"] == 21
    assert all(len(p["coords"]) == 2 for p in pts["points"])
    assert all(np.isfinite(c) for p in pts["points"] for c in p["coords"])


def test_db_migration_v2_to_v3_keeps_embedding_runs(settings: Settings) -> None:
    """Upgrade path for EXISTING projects: opening a v2 database
    creates projection_runs additively, keeps embedding runs and vectors
    pointers intact, and leaves a backup."""
    from app.storage.db import open_database
    from app.storage.projects_store import ProjectStore
    from sqlalchemy import text

    store = ProjectStore(settings.data_dir)
    ctx = store.create_project("upgrade", [str(Path(__file__).parent)])
    db_path = ctx.project_dir / "project.db"

    with ctx.session_factory() as session:
        session.add(
            EmbeddingRunRow(
                id="run-keep-0000001",
                model_id="sentence-transformers/all-MiniLM-L6-v2",
                dim=384,
                mode="raw_fragment",
                template="t",
                params_json="{}",
                npz_relpath="cache/embeddings/run-keep-0000001.npz",
                count=21,
                created_at="2026-10-15T10:00:00+00:00",
                updated_at="2026-10-15T10:00:00+00:00",
            )
        )
        session.commit()

    # Simulate a (v2) database: no projection_runs yet.
    with ctx.engine.begin() as conn:
        conn.execute(text("DROP TABLE projection_runs"))
        conn.execute(text("UPDATE meta SET value='2' WHERE key='schema_version'"))
    store.close_all()

    engine, factory = open_database(db_path)
    with factory() as session:
        kept = session.get(EmbeddingRunRow, "run-keep-0000001")
        assert kept is not None
        assert kept.count == 21
        assert kept.npz_relpath == "cache/embeddings/run-keep-0000001.npz"
    with engine.connect() as conn:
        version = conn.execute(
            text("SELECT value FROM meta WHERE key='schema_version'")
        ).scalar_one()
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
    engine.dispose()
    # v2 opens into whatever the CURRENT schema is (additively), never older
    from app.storage.db import CURRENT_DB_SCHEMA

    assert version == str(CURRENT_DB_SCHEMA)
    assert "projection_runs" in tables
    assert "projection_presets" in tables
    assert "embedding_runs" in tables
    backups = list(ctx.project_dir.glob("project.db.bak-*"))
    assert len(backups) == 1


# ---------------------------------------------------------------------------
# Raw axes method
# ---------------------------------------------------------------------------


def test_raw_axes_fit_selects_exact_columns() -> None:
    from app.projection_methods.raw_axes_method import RawAxesMethod

    rng = np.random.default_rng(9)
    data = rng.normal(size=(10, 8)).astype(np.float32)
    method = RawAxesMethod()
    params = method.validate_params({"axes": [2, 5, 0]})
    result = method.fit(data, n_components=3, params=params, seed=0)
    np.testing.assert_array_equal(result.coords, data[:, [2, 5, 0]])
    assert result.axis_labels == ("dim 2", "dim 5", "dim 0")
    # axis_info = original per-axis std (interpretation aid, not variance %)
    assert result.axis_info is not None
    np.testing.assert_allclose(result.axis_info, np.std(data[:, [2, 5, 0]], axis=0), atol=1e-5)


def test_raw_axes_standardize() -> None:
    from app.projection_methods.raw_axes_method import RawAxesMethod

    # axis 0 has a large scale, axis 1 a tiny one
    data = np.column_stack([np.linspace(-100, 100, 20), np.linspace(-0.01, 0.01, 20)]).astype(
        np.float32
    )
    method = RawAxesMethod()

    plain = method.fit(
        data, n_components=2, params=method.validate_params({"axes": [0, 1]}), seed=0
    )
    assert np.max(np.abs(plain.coords[:, 0])) > 50  # untouched raw values

    std = method.fit(
        data,
        n_components=2,
        params=method.validate_params({"axes": [0, 1], "standardize": True}),
        seed=0,
    )
    for col in range(2):
        assert abs(float(std.coords[:, col].mean())) < 1e-3
        assert abs(float(std.coords[:, col].std()) - 1.0) < 1e-3
    # axis_info still reports the ORIGINAL scale
    assert std.axis_info is not None
    assert std.axis_info[0] > 10 * std.axis_info[1]


def test_raw_axes_degenerate_axis_standardize_no_nan() -> None:
    from app.projection_methods.raw_axes_method import RawAxesMethod

    data = np.zeros((5, 4), dtype=np.float32)
    data[:, 1] = np.arange(5)
    method = RawAxesMethod()
    result = method.fit(
        data,
        n_components=2,
        params=method.validate_params({"axes": [0, 1], "standardize": True}),
        seed=0,
    )
    assert np.all(np.isfinite(result.coords))
    np.testing.assert_allclose(result.coords[:, 0], 0.0, atol=1e-6)


def test_raw_axes_guards() -> None:
    from app.projection_methods.raw_axes_method import RawAxesMethod

    method = RawAxesMethod()
    data = np.random.default_rng(4).normal(size=(10, 8)).astype(np.float32)
    ok = method.validate_params({"axes": [0, 1]})
    with pytest.raises(ProjectionParamsError, match="must equal n_components"):
        method.fit(data, n_components=3, params=ok, seed=0)
    with pytest.raises(ProjectionParamsError, match="out of range"):
        method.fit(data, n_components=2, params=method.validate_params({"axes": [0, 99]}), seed=0)
    with pytest.raises(ProjectionParamsError, match="at least 2 items"):
        method.validate_params({"axes": [3]})
    with pytest.raises(ProjectionParamsError, match="at most 4 items"):
        method.validate_params({"axes": [0, 1, 2, 3, 4]})
    with pytest.raises(ProjectionParamsError, match="duplicates"):
        method.validate_params({"axes": [2, 2]})
    with pytest.raises(ProjectionParamsError, match="list of integers"):
        method.validate_params({"axes": "not-a-list-object"})


def test_int_list_param_coercion() -> None:
    from app.projection_methods.raw_axes_method import RawAxesMethod

    method = RawAxesMethod()
    # comma-separated string is tolerated (hand-edited clients)
    assert method.validate_params({"axes": "12, 57"})["axes"] == [12, 57]
    # integer-valued floats coerce; fractional rejected
    assert method.validate_params({"axes": [3.0, 4.0]})["axes"] == [3, 4]
    with pytest.raises(ProjectionParamsError):
        method.validate_params({"axes": [1.5, 2]})
    with pytest.raises(ProjectionParamsError):
        method.validate_params({"axes": [True, 2]})


def test_raw_axes_api_flow(
    client: TestClient,
    sample_project: Path,
    settings: Settings,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    # 2 axes → ONE 2-component run (components derived, request value ignored)
    response = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "components": [3, 2],  # deliberately wrong — must be ignored
            "params": {"axes": [0, 3]},
            "seed": 7,
        },
    )
    assert response.status_code == 202, response.text
    info = wait_for_job(client, pid, response.json()["id"])
    assert info["state"] == "done", info

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert len(inventory) == 1, "raw_axes must create exactly one run"
    run = inventory[0]
    assert run["method"] == "raw_axes"
    assert run["n_components"] == 2
    assert run["axis_labels"] == ["dim 0", "dim 3"]
    assert run["params"] == {"axes": [0, 3], "standardize": False}

    # Served coordinates == exact columns of the stored vectors (rounding aside)
    emb_npz = settings.data_dir / "projects" / pid / "cache" / "embeddings" / f"{run_id}.npz"
    cache = NpzEmbeddingCache.load(emb_npz)
    assert cache is not None
    vectors_by_id = {fid: cache.vectors[i] for i, fid in enumerate(cache.ids)}
    points = client.get(f"/api/projects/{pid}/projections/{run['id']}/points").json()
    assert points["count"] == 21
    for point in points["points"]:
        expected = vectors_by_id[point["fragment_id"]][[0, 3]]
        np.testing.assert_allclose(point["coords"], expected, atol=1e-5)

    # 3 axes → 3D run
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "params": {"axes": [1, 2, 5]},
        },
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
    inv = client.get(f"/api/projects/{pid}/projections").json()
    assert {r["n_components"] for r in inv} == {2, 3}

    # Out-of-range axis is rejected before queueing (dim known from the run)
    bad = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "params": {"axes": [0, 99]},
        },
    )
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "invalid_projection_params"
    assert "out of range" in bad.json()["error"]["message"]


# ---------------------------------------------------------------------------
# Projection presets
# ---------------------------------------------------------------------------


def test_preset_crud_and_apply(
    client: TestClient, sample_project: Path, fake_provider_factory: dict[str, FakeProvider]
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    base = f"/api/projects/{pid}/projection-presets"

    assert client.get(base).json() == []

    created = client.post(
        base,
        json={
            "name": "Оси 0/3 + standardize",
            "method": "raw_axes",
            "params": {"axes": [0, 3], "standardize": True},
            "seed": 7,
        },
    )
    assert created.status_code == 201, created.text
    preset = created.json()
    assert preset["method_display_name"] == "Сырые оси"
    assert preset["params"] == {"axes": [0, 3], "standardize": True}

    # duplicate name → 409 with an actionable hint
    dup = client.post(base, json={"name": "Оси 0/3 + standardize", "method": "pca", "params": {}})
    assert dup.status_code == 409
    assert dup.json()["error"]["code"] == "preset_name_taken"

    # validation identical to compute: unknown method / bad params / blank name
    assert client.post(base, json={"name": "x", "method": "tsne", "params": {}}).status_code == 404
    assert (
        client.post(
            base, json={"name": "x", "method": "raw_axes", "params": {"axes": [1]}}
        ).status_code
        == 400
    )
    assert client.post(base, json={"name": "   ", "method": "pca", "params": {}}).status_code == 400

    # applying the preset = posting its params → works end-to-end
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": preset["method"],
            "params": preset["params"],
            "seed": preset["seed"],
        },
    )
    assert job.status_code == 202, job.text
    info = wait_for_job(client, pid, job.json()["id"])
    assert info["state"] == "done", info
    run = client.get(f"/api/projects/{pid}/projections").json()[0]
    assert run["params"]["standardize"] is True

    listed = client.get(base).json()
    assert len(listed) == 1

    deleted = client.delete(f"{base}/{preset['id']}")
    assert deleted.status_code == 200
    assert client.get(base).json() == []
    assert client.delete(f"{base}/{preset['id']}").status_code == 404


def test_db_migration_v3_to_v4_keeps_projections(settings: Settings) -> None:
    """Upgrade path for existing projects: opening a v3 database
    adds projection_presets without touching projection runs."""
    from app.storage.db import open_database
    from app.storage.projects_store import ProjectStore
    from sqlalchemy import text

    store = ProjectStore(settings.data_dir)
    ctx = store.create_project("up34", [str(Path(__file__).parent)])
    db_path = ctx.project_dir / "project.db"

    from app.storage.models import ProjectionRunRow

    with ctx.session_factory() as session:
        session.add(
            EmbeddingRunRow(
                id="emb-parent-0001",
                model_id="m",
                dim=8,
                mode="raw_fragment",
                template="",
                params_json="{}",
                npz_relpath="cache/embeddings/emb-parent-0001.npz",
                count=5,
                created_at="2026-10-15T10:00:00+00:00",
                updated_at="2026-10-15T10:00:00+00:00",
            )
        )
        session.add(
            ProjectionRunRow(
                id="proj-keep-0001",
                embedding_run_id="emb-parent-0001",
                method="pca",
                n_components=3,
                params_json="{}",
                seed=42,
                axis_labels_json='["PC1","PC2","PC3"]',
                versions_json="{}",
                npz_relpath="cache/projections/proj-keep-0001.npz",
                count=5,
                source_signature="sig",
                created_at="2026-10-15T10:00:00+00:00",
                updated_at="2026-10-15T10:00:00+00:00",
            )
        )
        session.commit()

    # Simulate a (v3) database.
    with ctx.engine.begin() as conn:
        conn.execute(text("DROP TABLE projection_presets"))
        conn.execute(text("UPDATE meta SET value='3' WHERE key='schema_version'"))
    store.close_all()

    engine, factory = open_database(db_path)
    with factory() as session:
        kept = session.get(ProjectionRunRow, "proj-keep-0001")
        assert kept is not None and kept.count == 5
    with engine.connect() as conn:
        version = conn.execute(
            text("SELECT value FROM meta WHERE key='schema_version'")
        ).scalar_one()
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
    engine.dispose()
    from app.storage.db import CURRENT_DB_SCHEMA

    assert version == str(CURRENT_DB_SCHEMA)
    assert "projection_presets" in tables
    assert "projection_runs" in tables


# ---------------------------------------------------------------------------
# 4-component projections (4D view: 3D scene + "time" slider on the 4th axis)
# ---------------------------------------------------------------------------


def test_pca_four_components_fit() -> None:
    data = np.random.default_rng(11).normal(size=(12, 8)).astype(np.float32)
    result = PcaMethod().fit(data, n_components=4, params={"whiten": False}, seed=42)
    assert result.coords.shape == (12, 4)
    assert result.axis_labels == ("PC1", "PC2", "PC3", "PC4")
    assert result.axis_info is not None and len(result.axis_info) == 4
    assert sum(result.axis_info) <= 1.0 + 1e-6


def test_raw_axes_four_axes_fit() -> None:
    from app.projection_methods.raw_axes_method import RawAxesMethod

    method = RawAxesMethod()
    data = np.random.default_rng(12).normal(size=(9, 8)).astype(np.float32)
    params = method.validate_params({"axes": [0, 1, 2, 7]})
    result = method.fit(data, n_components=4, params=params, seed=0)
    assert result.coords.shape == (9, 4)
    assert result.axis_labels == ("dim 0", "dim 1", "dim 2", "dim 7")
    np.testing.assert_allclose(result.coords, data[:, [0, 1, 2, 7]], atol=1e-6)


def test_projection_4d_api_flow(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    # PCA with 4 components → one 4D run (PC4 is the "time" axis in the UI).
    response = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [4], "seed": 42},
    )
    assert response.status_code == 202, response.text
    info = wait_for_job(client, pid, response.json()["id"])
    assert info["state"] == "done", info
    assert "PCA-4D" in str(info["message"])

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert len(inventory) == 1
    run = inventory[0]
    assert run["n_components"] == 4
    assert run["axis_labels"] == ["PC1", "PC2", "PC3", "PC4"]
    assert len(run["axis_info"]) == 4

    points = client.get(f"/api/projects/{pid}/projections/{run['id']}/points").json()
    assert points["n_components"] == 4
    assert points["count"] == 21
    assert all(len(p["coords"]) == 4 for p in points["points"])

    # raw_axes with 4 axes derives components=4 the same way.
    response = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "params": {"axes": [0, 1, 2, 3]},
        },
    )
    assert response.status_code == 202, response.text
    info = wait_for_job(client, pid, response.json()["id"])
    assert info["state"] == "done", info
    inventory = client.get(f"/api/projects/{pid}/projections").json()
    raw4 = next(r for r in inventory if r["method"] == "raw_axes")
    assert raw4["n_components"] == 4
    assert raw4["axis_labels"] == ["dim 0", "dim 1", "dim 2", "dim 3"]


# ---------------------------------------------------------------------------
# Multi axis-set builds ("0,1;0,2" — several 2D plots in one job)
# ---------------------------------------------------------------------------


def test_axis_sets_multi_build(
    client: TestClient,
    sample_project: Path,
    settings: Settings,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)

    response = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "axis_sets": [[0, 1], [0, 3]],
            "params": {"standardize": False},
            "seed": 5,
        },
    )
    assert response.status_code == 202, response.text
    info = wait_for_job(client, pid, response.json()["id"])
    assert info["state"] == "done", info
    assert "[0, 1]" in str(info["message"]) and "[0, 3]" in str(info["message"])

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert len(inventory) == 2, "one run per axis pair"
    by_axes = {tuple(r["params"]["axes"]): r for r in inventory}
    assert set(by_axes) == {(0, 1), (0, 3)}
    for run in by_axes.values():
        assert run["method"] == "raw_axes"
        assert run["n_components"] == 2
        assert run["seed"] == 5
        assert run["cache_ok"] is True

    # Coordinates of every plot are the exact columns of the stored vectors.
    emb_npz = settings.data_dir / "projects" / pid / "cache" / "embeddings" / f"{run_id}.npz"
    cache = NpzEmbeddingCache.load(emb_npz)
    assert cache is not None
    vectors_by_id = {fid: cache.vectors[i] for i, fid in enumerate(cache.ids)}
    for axes, run in by_axes.items():
        points = client.get(f"/api/projects/{pid}/projections/{run['id']}/points").json()
        assert points["count"] == 21
        for point in points["points"]:
            expected = vectors_by_id[point["fragment_id"]][list(axes)]
            np.testing.assert_allclose(point["coords"], expected, atol=1e-5)

    # Idempotent rebuild: same fingerprints → still exactly 2 runs.
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "axis_sets": [[0, 1], [0, 3]],
            "params": {"standardize": False},
            "seed": 5,
        },
    ).json()
    wait_for_job(client, pid, job["id"])
    assert len(client.get(f"/api/projects/{pid}/projections").json()) == 2


def test_axis_sets_validation_errors(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    base = f"/api/projects/{pid}/projections/compute"

    # axis_sets belongs to raw_axes only.
    wrong_method = client.post(
        base,
        json={"embedding_run_id": run_id, "method": "pca", "axis_sets": [[0, 1], [0, 2]]},
    )
    assert wrong_method.status_code == 400
    assert wrong_method.json()["error"]["code"] == "invalid_projection_params"
    assert "raw_axes" in wrong_method.json()["error"]["message"]

    # params.axes must not be mixed with axis_sets (no silent ignoring).
    ambiguous = client.post(
        base,
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "axis_sets": [[0, 1], [0, 2]],
            "params": {"axes": [0, 1]},
        },
    )
    assert ambiguous.status_code == 400
    assert ambiguous.json()["error"]["code"] == "invalid_projection_params"

    # Out-of-range axis inside a pair is rejected BEFORE queueing.
    out_of_range = client.post(
        base,
        json={"embedding_run_id": run_id, "method": "raw_axes", "axis_sets": [[0, 1], [0, 99]]},
    )
    assert out_of_range.status_code == 400
    assert "out of range" in out_of_range.json()["error"]["message"]

    # Schema-level violations: 3-axis set, duplicate set, single set, 7 sets.
    triple = client.post(
        base,
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "axis_sets": [[0, 1, 2], [0, 3]],
        },
    )
    assert triple.status_code == 422
    duplicate = client.post(
        base,
        json={"embedding_run_id": run_id, "method": "raw_axes", "axis_sets": [[0, 1], [0, 1]]},
    )
    assert duplicate.status_code == 422
    single = client.post(
        base,
        json={"embedding_run_id": run_id, "method": "raw_axes", "axis_sets": [[0, 1]]},
    )
    assert single.status_code == 422
    too_many = client.post(
        base,
        json={
            "embedding_run_id": run_id,
            "method": "raw_axes",
            "axis_sets": [[0, i] for i in range(1, 8)],
        },
    )
    assert too_many.status_code == 422


# ---------------------------------------------------------------------------
# Projection deletion (inventory hygiene)
# ---------------------------------------------------------------------------


def test_delete_projection_single(
    client: TestClient,
    sample_project: Path,
    settings: Settings,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "seed": 42},
    ).json()
    wait_for_job(client, pid, job["id"])
    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert len(inventory) == 2
    victim = next(r for r in inventory if r["n_components"] == 2)
    npz = settings.data_dir / "projects" / pid / "cache" / "projections" / f"{victim['id']}.npz"
    assert npz.exists()

    deleted = client.delete(f"/api/projects/{pid}/projections/{victim['id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": victim["id"]}

    inventory = client.get(f"/api/projects/{pid}/projections").json()
    assert [r["id"] for r in inventory] != victim["id"]
    assert len(inventory) == 1
    assert not npz.exists(), "coordinate cache file must be removed too"

    # Points of a deleted run are gone; deleting twice is a clean 404.
    assert client.get(f"/api/projects/{pid}/projections/{victim['id']}/points").status_code == 404
    again = client.delete(f"/api/projects/{pid}/projections/{victim['id']}")
    assert again.status_code == 404
    assert again.json()["error"]["code"] == "projection_not_found"

    # Embedding vectors are NOT projections: the run cache stays intact.
    emb_npz = settings.data_dir / "projects" / pid / "cache" / "embeddings" / f"{run_id}.npz"
    assert emb_npz.exists()


def test_delete_all_projections_requires_confirm_and_keeps_presets(
    client: TestClient,
    sample_project: Path,
    settings: Settings,
    fake_provider_factory: dict[str, FakeProvider],
) -> None:
    pid, run_id = _embedded_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "seed": 42},
    ).json()
    wait_for_job(client, pid, job["id"])
    preset = client.post(
        f"/api/projects/{pid}/projection-presets",
        json={"name": "keep-me", "method": "pca", "params": {"whiten": True}, "seed": 1},
    )
    assert preset.status_code == 201
    assert len(client.get(f"/api/projects/{pid}/projections").json()) == 2

    # Without confirmation the destructive bulk delete is refused.
    refused = client.delete(f"/api/projects/{pid}/projections")
    assert refused.status_code == 400
    assert refused.json()["error"]["code"] == "confirmation_required"
    assert len(client.get(f"/api/projects/{pid}/projections").json()) == 2

    result = client.delete(f"/api/projects/{pid}/projections?confirm=true")
    assert result.status_code == 200
    assert result.json() == {"deleted": 2}
    assert client.get(f"/api/projects/{pid}/projections").json() == []

    cache_dir = settings.data_dir / "projects" / pid / "cache" / "projections"
    assert not list(cache_dir.glob("*.npz")), "all coordinate caches removed"

    # Presets are form states, not computed views — they survive the cleanup.
    presets = client.get(f"/api/projects/{pid}/projection-presets").json()
    assert [p["name"] for p in presets] == ["keep-me"]

    # Embedding vectors stay intact: a rebuild right after works from cache.
    job = client.post(
        f"/api/projects/{pid}/projections/compute",
        json={"embedding_run_id": run_id, "method": "pca", "components": [3], "seed": 42},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
