"""Application entry point and factory.

Run with:
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.routes_health import router as health_router
from app.config import Settings, ensure_data_dir
from app.core.logging import get_logger, setup_logging
from app.core.security import LocalOnlyMiddleware

log = get_logger("main")


def _cors_origins(settings: Settings) -> list[str]:
    return [
        f"http://{host}:{port}"
        for host in ("localhost", "127.0.0.1")
        for port in settings.frontend_ports
    ]


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI application with all middleware and routers."""
    setup_logging()
    resolved = settings if settings is not None else Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        ensure_data_dir(resolved)
        log.info(
            "backend %s started on %s:%d, data dir: %s",
            __version__,
            resolved.host,
            resolved.port,
            resolved.data_dir,
        )
        yield

    app = FastAPI(
        title="Embedding Space Explorer API",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = resolved

    # Order matters: middleware added later runs first (outermost).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(resolved),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(LocalOnlyMiddleware)

    app.include_router(health_router)
    return app


app = create_app()
