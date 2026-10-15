"""Tests for GET /api/health diagnostics."""

from __future__ import annotations

from pathlib import Path

from app import SCHEMA_VERSION, __version__
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient


def test_health_reports_ok(client: TestClient, settings: Settings) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["app_version"] == __version__
    assert body["schema_version"] == SCHEMA_VERSION
    assert body["loopback_only"] is True
    assert body["data_dir"] == str(settings.data_dir)
    assert body["python_version"]
    assert body["platform"]


def test_health_creates_data_dir(client: TestClient, settings: Settings) -> None:
    client.get("/api/health")
    assert settings.data_dir.is_dir()


def test_health_checks_are_ok(client: TestClient) -> None:
    body = client.get("/api/health").json()
    checks = {c["name"]: c for c in body["checks"]}
    assert checks["data_dir_writable"]["status"] == "ok"
    assert checks["loopback_binding"]["status"] == "ok"
    assert checks["required_dependencies"]["status"] == "ok"


def test_health_required_dependencies_installed(client: TestClient) -> None:
    body = client.get("/api/health").json()
    deps = {d["name"]: d for d in body["dependencies"]}
    for name in (
        "fastapi",
        "pydantic",
        "uvicorn",
        "sqlalchemy",
        "tree-sitter",
        "tree-sitter-python",
        "tree-sitter-javascript",
        "tree-sitter-typescript",
        "numpy",
        "torch",
        "sentence-transformers",
        "scikit-learn",
        "umap-learn",
    ):
        assert deps[name]["required"] is True
        assert deps[name]["installed"] is True
        assert deps[name]["version"]


def test_health_reports_degraded_for_non_loopback_host(tmp_path: Path) -> None:
    settings = Settings(host="0.0.0.0", data_dir=tmp_path / "ese-data")
    app = create_app(settings)
    with TestClient(app) as non_loopback_client:
        non_loopback_client.headers["Host"] = "127.0.0.1:8000"
        body = non_loopback_client.get("/api/health").json()
    assert body["loopback_only"] is False
    assert body["status"] == "degraded"
    checks = {c["name"]: c for c in body["checks"]}
    assert checks["loopback_binding"]["status"] == "warn"
