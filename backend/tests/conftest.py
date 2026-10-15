"""Pytest fixtures for backend tests."""

from __future__ import annotations

import shutil
import sys
import time
from collections.abc import Iterator
from pathlib import Path

# Make the `app` package importable no matter which directory pytest is
# launched from. Canonical way: run from backend/ (pyproject.toml sets
# pythonpath=["."]); this bootstrap also covers a bare `pytest` from the
# repository root, where backend/pyproject.toml is not picked up as ini.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import pytest  # noqa: E402
from app.config import Settings  # noqa: E402
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
