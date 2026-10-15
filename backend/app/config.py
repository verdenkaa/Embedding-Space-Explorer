"""Application configuration.

All runtime settings are read from environment variables with safe defaults.
The backend is a local research tool: by default it binds to the loopback
interface only and never requires cloud credentials or admin rights.

Environment variables:
    ESE_HOST             interface to bind (default 127.0.0.1)
    ESE_PORT             port to bind (default 8000)
    ESE_DATA_DIR         root directory for projects/caches
                         (default ~/.embedding-space-explorer)
    ESE_FRONTEND_PORTS   comma-separated frontend ports allowed for CORS
                         (default 5173)
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "embedding-space-explorer"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
DEFAULT_FRONTEND_PORTS: tuple[int, ...] = (5173,)

LOOPBACK_HOSTNAMES = frozenset({"127.0.0.1", "localhost", "::1"})


def default_data_dir() -> Path:
    """Return the default root directory for user data (projects, caches)."""
    return Path.home() / ".embedding-space-explorer"


@dataclass(frozen=True)
class Settings:
    """Immutable runtime settings resolved once at application start."""

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    data_dir: Path = field(default_factory=default_data_dir)
    frontend_ports: tuple[int, ...] = DEFAULT_FRONTEND_PORTS

    @property
    def loopback_only(self) -> bool:
        """True when the server is not reachable from the local network."""
        return self.host in LOOPBACK_HOSTNAMES or self.host.startswith("127.")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        """Build settings from environment variables, validating every value."""
        source: Mapping[str, str] = os.environ if env is None else env

        host = source.get("ESE_HOST", "").strip() or DEFAULT_HOST

        port_raw = source.get("ESE_PORT", "").strip()
        port = DEFAULT_PORT if not port_raw else _parse_port(port_raw, "ESE_PORT")

        data_raw = source.get("ESE_DATA_DIR", "").strip()
        data_dir = Path(data_raw).expanduser() if data_raw else default_data_dir()

        ports_raw = source.get("ESE_FRONTEND_PORTS", "").strip()
        frontend_ports = (
            DEFAULT_FRONTEND_PORTS
            if not ports_raw
            else tuple(
                _parse_port(part, "ESE_FRONTEND_PORTS")
                for part in (p.strip() for p in ports_raw.split(","))
                if part
            )
        )

        return cls(host=host, port=port, data_dir=data_dir, frontend_ports=frontend_ports)


def _parse_port(raw: str, var_name: str) -> int:
    try:
        port = int(raw)
    except ValueError as exc:
        raise ValueError(f"{var_name} must be an integer, got {raw!r}") from exc
    if not 1 <= port <= 65535:
        raise ValueError(f"{var_name} must be in 1..65535, got {port}")
    return port


def ensure_data_dir(settings: Settings) -> None:
    """Create the data directory (idempotent). Called on application startup."""
    settings.data_dir.mkdir(parents=True, exist_ok=True)
