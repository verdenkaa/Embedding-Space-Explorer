"""Pytest fixtures for backend tests.

Shared fakes live here so every API-level test module drives the
same deterministic embedding provider (no torch needed for logic tests).
"""

from __future__ import annotations

import hashlib
import shutil
import sys
import time
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path

# Make the `app` package importable no matter which directory pytest is
# launched from. Canonical way: run from backend/ (pyproject.toml sets
# pythonpath=["."]); this bootstrap also covers a bare `pytest` from the
# repository root, where backend/pyproject.toml is not picked up as ini.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from app.config import Settings  # noqa: E402
from app.embedding_providers.base import EmbeddingProvider, ModelInfo  # noqa: E402
from app.main import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

FIXTURES_DIR = Path(__file__).parent / "fixtures"
SAMPLE_PROJECT = FIXTURES_DIR / "sample_project"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Settings pointing at a temporary data directory."""
    return Settings(data_dir=tmp_path / "ese-data")


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    """TestClient with a loopback Host header (as a local browser would send)."""
    app = create_app(settings)
    with TestClient(app) as test_client:
        test_client.headers["Host"] = "127.0.0.1:8000"
        yield test_client


@pytest.fixture
def sample_project(tmp_path: Path) -> Path:
    """A writable copy of the fixture project (tests mutate it freely)."""
    target = tmp_path / "src_tree"
    shutil.copytree(SAMPLE_PROJECT, target)
    return target


def wait_for_job(
    client: TestClient, project_id: str, job_id: str, timeout: float = 30.0
) -> dict[str, object]:
    """Poll a job until it leaves queued/running; fail the test on timeout."""
    deadline = time.monotonic() + timeout
    last: dict[str, object] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/projects/{project_id}/jobs/{job_id}")
        assert response.status_code == 200, response.text
        last = response.json()
        if last["state"] in ("done", "failed", "cancelled"):
            return last
        time.sleep(0.05)
    pytest.fail(f"job {job_id} did not finish in {timeout}s; last state: {last}")


# ---------------------------------------------------------------------------
# Shared fakes: deterministic embedding provider (no torch/sentence-transformers)
# ---------------------------------------------------------------------------

FAKE_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"  # real catalog entry
FAKE_DIM = 8


class FakeProvider(EmbeddingProvider):
    """Deterministic hash-based vectors; no heavy dependencies."""

    def __init__(self, info: ModelInfo, *, downloaded: bool = True, slow: bool = False) -> None:
        self._info = info
        self._downloaded = downloaded
        self._slow = slow
        self.encode_calls = 0

    def info(self) -> ModelInfo:
        return self._info

    def is_downloaded(self) -> bool:
        return self._downloaded

    def download(self, progress_message: Callable[[str], None] | None = None) -> None:
        if progress_message:
            progress_message("fake download")
        self._downloaded = True

    def encode(
        self,
        texts: Sequence[str],
        *,
        batch_size: int = 16,
        normalize: bool = True,
        progress_cb: Callable[[int, int], None] | None = None,
        cancel_check: Callable[[], None] | None = None,
    ) -> np.ndarray:
        rows: list[np.ndarray] = []
        done = 0
        for start in range(0, len(texts), batch_size):
            if cancel_check is not None:
                cancel_check()
            batch = list(texts[start : start + batch_size])
            for text in batch:
                digest = hashlib.sha256(text.encode("utf-8")).digest()
                vec = np.array([b / 255.0 for b in digest[:FAKE_DIM]], dtype=np.float32)
                if normalize:
                    vec = vec / np.linalg.norm(vec)
                rows.append(vec)
            done += len(batch)
            if progress_cb is not None:
                progress_cb(done, len(texts))
            if self._slow:
                time.sleep(0.05)
        self.encode_calls += 1
        if not rows:
            return np.zeros((0, FAKE_DIM), dtype=np.float32)
        return np.vstack(rows)


@pytest.fixture
def fake_provider_factory(monkeypatch: pytest.MonkeyPatch) -> dict[str, FakeProvider]:
    """Patch provider creation in jobs and routes with a shared fake."""
    created: dict[str, FakeProvider] = {}

    def factory(model_id: str, data_dir: Path) -> FakeProvider:
        if model_id not in created:
            info = ModelInfo(
                model_id=model_id,
                display_name=model_id.split("/")[-1],
                dim=FAKE_DIM,
                approx_download_mb=1,
                description="fake",
            )
            created[model_id] = FakeProvider(info)
        return created[model_id]

    import app.api.routes_embeddings as routes_mod
    import app.jobs.embedding as jobs_mod

    monkeypatch.setattr(jobs_mod, "create_provider", factory)
    monkeypatch.setattr(routes_mod, "create_provider", factory)
    return created


def create_indexed_project(client: TestClient, sample_project: Path) -> str:
    """Create a project over the fixture corpus and index it (21 fragments)."""
    response = client.post("/api/projects", json={"name": "Emb", "roots": [str(sample_project)]})
    assert response.status_code == 201, response.text
    pid: str = str(response.json()["id"])
    job = client.post(f"/api/projects/{pid}/index").json()
    info = wait_for_job(client, pid, job["id"])
    assert info["state"] == "done", info
    return pid
