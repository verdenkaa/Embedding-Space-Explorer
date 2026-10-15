"""Pytest fixtures for backend tests."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient


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
