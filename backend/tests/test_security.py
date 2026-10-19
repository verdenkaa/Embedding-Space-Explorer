"""Tests for the loopback-only security middleware."""

from __future__ import annotations

import pytest
from app.core.security import _hostname, _is_local_origin
from fastapi.testclient import TestClient


def test_health_ok_with_loopback_host(client: TestClient) -> None:
    assert client.get("/api/health").status_code == 200


@pytest.mark.parametrize(
    "host_header",
    ["evil.example.com", "192.168.1.50:8000", "attacker.test", "testserver"],
)
def test_foreign_host_blocked(client: TestClient, host_header: str) -> None:
    response = client.get("/api/health", headers={"Host": host_header})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden_host"


def test_ipv6_loopback_host_allowed(client: TestClient) -> None:
    response = client.get("/api/health", headers={"Host": "[::1]:8000"})
    assert response.status_code == 200


def test_localhost_host_allowed(client: TestClient) -> None:
    response = client.get("/api/health", headers={"Host": "localhost:8000"})
    assert response.status_code == 200


def test_mutating_request_with_foreign_origin_blocked(client: TestClient) -> None:
    response = client.post("/api/health", headers={"Origin": "http://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden_origin"


def test_mutating_request_with_local_origin_passes_middleware(client: TestClient) -> None:
    response = client.post(
        "/api/nonexistent",
        headers={"Origin": "http://localhost:5173"},
    )
    # Middleware lets it through; routing answers 404 for the unknown path.
    assert response.status_code == 404


def test_mutating_request_without_origin_allowed(client: TestClient) -> None:
    # Local non-browser clients (curl, tests) do not send Origin.
    response = client.post("/api/nonexistent")
    assert response.status_code == 404


def test_get_with_foreign_origin_is_not_blocked_by_middleware(client: TestClient) -> None:
    # Reads are protected by CORS (browser hides the response), not by 403.
    response = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize(
    ("netloc", "expected"),
    [
        ("127.0.0.1:8000", "127.0.0.1"),
        ("localhost:5173", "localhost"),
        ("[::1]:8000", "::1"),
        ("evil.example.com", "evil.example.com"),
        ("", ""),
    ],
)
def test_hostname_parsing(netloc: str, expected: str) -> None:
    assert _hostname(netloc) == expected


@pytest.mark.parametrize(
    ("origin", "expected"),
    [
        ("http://localhost:5173", True),
        ("http://127.0.0.1:5173", True),
        ("http://[::1]:5173", True),
        ("https://localhost", True),
        ("http://evil.example", False),
        ("http://192.168.1.5:5173", False),
        ("null", False),
        ("", False),
    ],
)
def test_local_origin_detection(origin: str, expected: bool) -> None:
    assert _is_local_origin(origin) is expected
