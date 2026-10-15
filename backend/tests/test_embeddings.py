"""Stage-2 embedding tests.

Unit/logic tests run WITHOUT torch/sentence-transformers (fake provider
injection). The real-model integration test is marked `real_model` and
deselected by default (opt-in: `pytest -m real_model`) — it downloads
~90 MB of weights on first run.
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest
from app.config import Settings
from app.embedding_providers.base import ModelInfo, params_fingerprint
from app.embedding_providers.preparation import (
    CONTEXT_TEMPLATE,
    MODE_CONTEXT,
    MODE_RAW,
    FragmentText,
    prepare_text,
    prepared_text_hash,
    render_template_preview,
)
from app.storage.db import open_database
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
# Preparation modes
# ---------------------------------------------------------------------------


def _fragment_text(text: str = "def f():\n    pass") -> FragmentText:
    return FragmentText(
        text=text,
        rel_path="src/app.py",
        symbol_path="Cls.f",
        kind="method",
        parent_symbol_path="Cls",
        language="python",
    )


def test_raw_mode_is_exact_text() -> None:
    ft = _fragment_text()
    assert prepare_text(ft, MODE_RAW) == ft.text


def test_context_mode_contains_all_declared_fields() -> None:
    ft = _fragment_text()
    prepared = prepare_text(ft, MODE_CONTEXT)
    assert "# path: src/app.py" in prepared
    assert "# symbol: Cls.f" in prepared
    assert "# kind: method" in prepared
    assert "# parent: Cls" in prepared
    assert "# language: python" in prepared
    assert prepared.endswith(ft.text)


def test_context_without_parent_uses_dash() -> None:
    ft = FragmentText(
        text="x",
        rel_path="a.py",
        symbol_path="x",
        kind="chunk",
        parent_symbol_path=None,
        language="python",
    )
    assert "# parent: -" in prepare_text(ft, MODE_CONTEXT)


def test_unknown_mode_raises() -> None:
    with pytest.raises(ValueError, match="unknown preparation mode"):
        prepare_text(_fragment_text(), "magic")


def test_modes_produce_different_hashes() -> None:
    ft = _fragment_text()
    raw = prepared_text_hash(prepare_text(ft, MODE_RAW))
    ctx = prepared_text_hash(prepare_text(ft, MODE_CONTEXT))
    assert raw != ctx
    # Deterministic.
    assert prepared_text_hash(prepare_text(ft, MODE_CONTEXT)) == ctx


def test_template_preview() -> None:
    assert "только текст" in render_template_preview(MODE_RAW)
    preview = render_template_preview(MODE_CONTEXT)
    assert "src/app/calculator.py" in preview and "Calculator.add" in preview


def test_params_fingerprint_sensitivity() -> None:
    base = params_fingerprint("m", MODE_RAW, CONTEXT_TEMPLATE, {"batch_size": 16})
    assert base == params_fingerprint("m", MODE_RAW, CONTEXT_TEMPLATE, {"batch_size": 16})
    assert base != params_fingerprint("m2", MODE_RAW, CONTEXT_TEMPLATE, {"batch_size": 16})
    assert base != params_fingerprint("m", MODE_CONTEXT, CONTEXT_TEMPLATE, {"batch_size": 16})
    assert base != params_fingerprint("m", MODE_RAW, CONTEXT_TEMPLATE + "x", {"batch_size": 16})
    assert base != params_fingerprint("m", MODE_RAW, CONTEXT_TEMPLATE, {"batch_size": 32})


# ---------------------------------------------------------------------------
# NpzEmbeddingCache
# ---------------------------------------------------------------------------


def test_npz_cache_roundtrip_and_upsert(tmp_path: Path) -> None:
    path = tmp_path / "run.npz"
    cache = NpzEmbeddingCache.load(path)
    assert len(cache) == 0

    vecs = np.eye(3, 4, dtype=np.float32)
    cache.upsert(["a", "b", "c"], ["ha", "hb", "hc"], ["fa", "fb", "fc"], vecs)
    cache.save()

    loaded = NpzEmbeddingCache.load(path)
    assert len(loaded) == 3
    assert loaded.dim == 4
    assert loaded.text_hash_of("b") == "hb"
    vec_a = loaded.vector_of("a")
    assert loaded.vector_of("c") is not None
    assert vec_a is not None
    np.testing.assert_allclose(vec_a, vecs[0])

    # Upsert replaces existing entries, keeps others.
    loaded.upsert(["b"], ["hb2"], ["fb2"], np.full((1, 4), 0.5, dtype=np.float32))
    assert len(loaded) == 3
    assert loaded.text_hash_of("b") == "hb2"
    assert loaded.text_hash_of("a") == "ha"


def test_npz_cache_prune(tmp_path: Path) -> None:
    path = tmp_path / "run.npz"
    cache = NpzEmbeddingCache.load(path)
    cache.upsert(
        ["a", "b", "c"],
        ["ha", "hb", "hc"],
        ["fa", "fb", "fc"],
        np.eye(3, 4, dtype=np.float32),
    )
    # 'a' still valid, 'b' content changed (stale), 'c' deleted (orphan).
    removed = cache.prune({"a": "fa", "b": "fb-NEW"})
    assert removed == 2
    assert cache.ids == ["a"]


def test_npz_cache_corrupted_file_recovers(tmp_path: Path) -> None:
    path = tmp_path / "run.npz"
    path.write_bytes(b"not an npz archive at all")
    cache = NpzEmbeddingCache.load(path)  # must not raise
    assert len(cache) == 0


# ---------------------------------------------------------------------------
# API flow with the fake provider
# ---------------------------------------------------------------------------


def test_models_catalog_reports_download_status(
    client: TestClient, fake_provider_factory: dict[str, FakeProvider]
) -> None:
    fake_provider_factory[FAKE_MODEL_ID] = FakeProvider(
        ModelInfo(FAKE_MODEL_ID, "all-MiniLM-L6-v2", FAKE_DIM, 1, "fake"), downloaded=False
    )
    response = client.get("/api/models")
    assert response.status_code == 200
    models = {m["model_id"]: m for m in response.json()}
    assert models[FAKE_MODEL_ID]["downloaded"] is False
    default = models["sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"]
    assert default["is_default"] is True
    assert default["dim"] == 384
    assert "НЕ специализирована" in default["description"]


def test_embed_flow_compute_cache_and_incremental(
    client: TestClient, sample_project: Path, fake_provider_factory: dict[str, FakeProvider]
) -> None:
    pid = create_indexed_project(client, sample_project)

    # Not downloaded -> job fails with an actionable error.
    fake_provider_factory[FAKE_MODEL_ID] = FakeProvider(
        ModelInfo(FAKE_MODEL_ID, "all-MiniLM-L6-v2", FAKE_DIM, 1, "fake"), downloaded=False
    )
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "failed"
    assert "not downloaded" in str(info["error"])

    # Download job makes it available (fake).
    job = client.post(
        f"/api/projects/{pid}/models/download", json={"model_id": FAKE_MODEL_ID}
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done"

    # Compute: all 21 fixture fragments embedded.
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW, "batch_size": 4},
    ).json()
    info = wait_for_job(client, pid, job["id"], timeout=60)
    assert info["state"] == "done", info
    assert "embedded 21 vectors" in str(info["message"])

    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    assert len(runs) == 1
    run = runs[0]
    assert run["mode"] == MODE_RAW
    assert run["dim"] == FAKE_DIM
    assert run["coverage"] == {
        "fragments_total": 21,
        "embedded": 21,
        "stale": 0,
        "missing": 0,
    }

    # Recompute: everything cached, zero new vectors.
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW, "batch_size": 4},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done"
    assert "embedded 0 vectors" in str(info["message"])
    assert "21 reused" in str(info["message"])

    # Batch size is an execution detail: changing it must REUSE the cache
    # (TZ §12: low-RAM users lower batch size without losing results).
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW, "batch_size": 16},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done"
    assert "embedded 0 vectors" in str(info["message"])
    runs_same = client.get(f"/api/projects/{pid}/embeddings").json()
    assert len(runs_same) == 1, "batch size must not create a second run"

    # Context mode = a SEPARATE run (never mixed).
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_CONTEXT},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done"
    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    assert len(runs) == 2
    assert {r["mode"] for r in runs} == {MODE_RAW, MODE_CONTEXT}
    assert runs[0]["id"] != runs[1]["id"]


def test_reindex_prunes_stale_vectors(
    client: TestClient, sample_project: Path, fake_provider_factory: dict[str, FakeProvider]
) -> None:
    pid = create_indexed_project(client, sample_project)
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW},
    ).json()
    wait_for_job(client, pid, job["id"])

    # Modify one file, delete another.
    utils = sample_project / "src" / "utils.js"
    utils.write_text(
        utils.read_text(encoding="utf-8") + "\nfunction added() {}\n", encoding="utf-8"
    )
    (sample_project / "web" / "types.ts").unlink()

    job = client.post(f"/api/projects/{pid}/index").json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done"
    warnings = info["warnings"]
    assert isinstance(warnings, list)
    assert any("pruned" in str(w) for w in warnings)

    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    cov = runs[0]["coverage"]
    # types.ts vectors (4) pruned as orphans; utils.js vectors (5) pruned as
    # stale; added() is missing. Embedded == fragments of untouched files.
    assert cov["stale"] == 0  # stale entries were PRUNED, not left behind
    assert cov["embedded"] + cov["missing"] == cov["fragments_total"]
    assert cov["missing"] > 0

    # Recompute fills the gaps only.
    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW},
    ).json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done"
    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    assert runs[0]["coverage"]["missing"] == 0
    assert runs[0]["coverage"]["embedded"] == runs[0]["coverage"]["fragments_total"]


def test_embed_cancel_keeps_partial_results(
    client: TestClient,
    sample_project: Path,
    fake_provider_factory: dict[str, FakeProvider],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pid = create_indexed_project(client, sample_project)

    # Slow provider + batch_size=1 gives time to cancel mid-run.
    def factory(model_id: str, data_dir: Path) -> FakeProvider:
        info = ModelInfo(model_id, "fake", FAKE_DIM, 1, "fake")
        return FakeProvider(info, slow=True)

    import app.jobs.embedding as jobs_mod

    monkeypatch.setattr(jobs_mod, "create_provider", factory)

    job = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW, "batch_size": 1},
    ).json()
    # Wait until it starts embedding something, then cancel.
    for _ in range(100):
        info = client.get(f"/api/projects/{pid}/jobs/{job['id']}").json()
        if info["state"] == "running" and info["progress_done"] >= 2:
            break
        time.sleep(0.05)
    client.post(f"/api/projects/{pid}/jobs/{job['id']}/cancel")
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "cancelled"

    # Partial vectors were checkpointed, not lost.
    runs = client.get(f"/api/projects/{pid}/embeddings").json()
    assert len(runs) == 1
    assert runs[0]["coverage"]["embedded"] >= 1


def test_embed_validation_errors(client: TestClient, sample_project: Path) -> None:
    pid = create_indexed_project(client, sample_project)

    unknown = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": "no/such-model", "mode": MODE_RAW},
    )
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "unknown_model"

    bad_mode = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": "vibes"},
    )
    assert bad_mode.status_code == 422

    bad_batch = client.post(
        f"/api/projects/{pid}/embeddings/compute",
        json={"model_id": FAKE_MODEL_ID, "mode": MODE_RAW, "batch_size": 9999},
    )
    assert bad_batch.status_code == 422


# ---------------------------------------------------------------------------
# DB migration v1 -> v2 (additive, non-destructive)
# ---------------------------------------------------------------------------


def test_db_migration_from_v1_is_additive(settings: Settings) -> None:
    from app.storage.models import FileRow
    from app.storage.projects_store import ProjectStore
    from sqlalchemy import text

    store = ProjectStore(settings.data_dir)
    ctx = store.create_project("mig", [str(Path(__file__).parent)])
    db_path = ctx.project_dir / "project.db"

    # Put a real row into files so we can prove data survives the migration.
    with ctx.session_factory() as session:
        session.add(
            FileRow(
                id="keep1",
                root="/r",
                rel_path="a.py",
                abs_path="/r/a.py",
                size=1,
                mtime=0.0,
                status="indexed",
            )
        )
        session.commit()

    # Downgrade: simulate a v1 database (drop later tables, set meta=1).
    with ctx.engine.begin() as conn:
        conn.execute(text("DROP TABLE embedding_runs"))
        conn.execute(text("DROP TABLE projection_runs"))
        conn.execute(text("DROP TABLE projection_presets"))
        conn.execute(text("UPDATE meta SET value='1' WHERE key='schema_version'"))
    store.close_all()

    # Re-open: migration must recreate the table, bump meta, keep data,
    # and leave a backup copy (TZ §9.4).
    engine, factory = open_database(db_path)
    with factory() as session:
        kept = session.get(FileRow, "keep1")
        assert kept is not None and kept.rel_path == "a.py"
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
    assert "embedding_runs" in tables
    assert "projection_runs" in tables
    assert "projection_presets" in tables
    assert "files" in tables
    backups = list(ctx.project_dir.glob("project.db.bak-*"))
    assert len(backups) == 1


# ---------------------------------------------------------------------------
# Real model integration (opt-in: pytest -m real_model)
# ---------------------------------------------------------------------------


@pytest.mark.real_model
def test_real_model_encode(tmp_path: Path) -> None:
    """Real sentence-transformers inference with the SMALL catalog model.

    Downloads ~90 MB on first run (cached under <data_dir>/models).
    The default multilingual model (~470 MB) is exercised by the manual
    checklist on the user's machine.
    """
    from app.embedding_providers.registry import create_provider

    provider = create_provider(FAKE_MODEL_ID, tmp_path)
    if not provider.is_downloaded():
        provider.download()
    assert provider.is_downloaded()

    vectors = provider.encode(
        ["def foo():\n    return 1", "class Bar:\n    pass", "def foo():\n    return 1"],
        batch_size=2,
        normalize=True,
    )
    assert vectors.shape == (3, 384)
    assert vectors.dtype == np.float32
    norms = np.linalg.norm(vectors, axis=1)
    np.testing.assert_allclose(norms, 1.0, atol=1e-5)
    # Identical texts -> identical vectors; cosine in [-1, 1].
    np.testing.assert_allclose(vectors[0], vectors[2], atol=1e-6)
    assert abs(float(vectors[0] @ vectors[1])) <= 1.0 + 1e-6
