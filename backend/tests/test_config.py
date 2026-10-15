"""Tests for environment-based configuration parsing."""

from __future__ import annotations

from pathlib import Path

import pytest
from app.config import DEFAULT_PORT, Settings, default_data_dir


def test_defaults() -> None:
    settings = Settings.from_env({})
    assert settings.host == "127.0.0.1"
    assert settings.port == DEFAULT_PORT
    assert settings.data_dir == default_data_dir()
    assert settings.loopback_only is True


def test_env_overrides(tmp_path: Path) -> None:
    env = {
        "ESE_HOST": "127.0.0.1",
        "ESE_PORT": "8123",
        "ESE_DATA_DIR": str(tmp_path / "custom"),
        "ESE_FRONTEND_PORTS": "5173,5174",
    }
    settings = Settings.from_env(env)
    assert settings.port == 8123
    assert settings.data_dir == tmp_path / "custom"
    assert settings.frontend_ports == (5173, 5174)


def test_non_loopback_host_detected() -> None:
    settings = Settings.from_env({"ESE_HOST": "0.0.0.0"})
    assert settings.loopback_only is False


def test_loopback_subnet_host_detected() -> None:
    settings = Settings.from_env({"ESE_HOST": "127.0.0.53"})
    assert settings.loopback_only is True


@pytest.mark.parametrize("bad_port", ["abc", "0", "70000", "-1"])
def test_invalid_port_rejected(bad_port: str) -> None:
    with pytest.raises(ValueError, match="ESE_PORT"):
        Settings.from_env({"ESE_PORT": bad_port})


def test_invalid_frontend_port_rejected() -> None:
    with pytest.raises(ValueError, match="ESE_FRONTEND_PORTS"):
        Settings.from_env({"ESE_FRONTEND_PORTS": "5173,nope"})
