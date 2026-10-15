"""Pytest fixtures for backend tests."""

from __future__ import annotations

import sys
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
