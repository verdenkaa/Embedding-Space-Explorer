"""Loopback-only HTTP protection.

Threat model for a local web application (TZ §11):

1. Any web page open in the user's browser can issue requests to
   ``http://127.0.0.1:<port>``. Reads are mitigated by CORS (the browser hides
   responses from disallowed origins), but *state-changing* requests (POST etc.)
   may still reach the server — so mutating methods require a local ``Origin``.
2. DNS rebinding: an attacker-controlled domain resolving to 127.0.0.1 would
   pass CORS if we trusted only the network address. We therefore validate the
   ``Host`` header against an explicit loopback allowlist.

The middleware rejects everything else with a structured 403 JSON error using
the same envelope as the rest of the API (see ``api/schemas.py``).
"""

from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import urlparse

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import LOOPBACK_HOSTNAMES

MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _hostname(netloc: str) -> str:
    """Extract the lowercase hostname from a ``host:port`` value."""
    if not netloc:
        return ""
    if netloc.startswith("["):  # IPv6 literal, e.g. [::1]:8000
        end = netloc.find("]")
        return netloc[1:end].lower() if end != -1 else ""
    return netloc.rsplit(":", 1)[0].lower() if ":" in netloc else netloc.lower()


def _is_local_origin(origin: str) -> bool:
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"}:
        return False
    return parsed.hostname is not None and parsed.hostname.lower() in LOOPBACK_HOSTNAMES


def _forbidden(code: str, message: str, hint: str) -> JSONResponse:
    return JSONResponse(
        status_code=403,
        content={"error": {"code": code, "message": message, "hint": hint}},
    )


class LocalOnlyMiddleware:
    """ASGI middleware enforcing loopback Host and local Origin on mutations.

    Pure-ASGI (not BaseHTTPMiddleware) so streaming responses and background
    tasks behave normally.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_hosts: Iterable[str] = LOOPBACK_HOSTNAMES,
    ) -> None:
        self.app = app
        self.allowed_hosts = frozenset(allowed_hosts)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)

        host = _hostname(request.headers.get("host", ""))
        if host not in self.allowed_hosts:
            response = _forbidden(
                "forbidden_host",
                f"Host '{host or '<missing>'}' is not allowed; this server only accepts "
                "loopback host names.",
                "Access the backend via http://127.0.0.1 or http://localhost only.",
            )
            await response(scope, receive, send)
            return

        method = scope.get("method", "GET").upper()
        if method in MUTATING_METHODS:
            origin = request.headers.get("origin")
            # Browsers always send Origin on cross-origin and mutating requests.
            # A missing Origin means a same-origin request or a non-browser local
            # client (curl / tests), which is acceptable for a loopback server.
            if origin is not None and not _is_local_origin(origin):
                response = _forbidden(
                    "forbidden_origin",
                    f"Origin '{origin}' is not allowed to perform mutating requests.",
                    "Only local frontends (http://localhost / http://127.0.0.1) may modify data.",
                )
                await response(scope, receive, send)
                return

        await self.app(scope, receive, send)
