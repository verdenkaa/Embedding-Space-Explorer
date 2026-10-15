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
from app.api.errors import install_error_handlers
from app.api.routes_embeddings import embeddings_router, models_router, preparation_router
from app.api.routes_files import router as files_router
from app.api.routes_fragments import router as fragments_router
from app.api.routes_fs import router as fs_router
from app.api.routes_health import router as health_router
from app.api.routes_jobs import router as jobs_router
from app.api.routes_projections import methods_router as projection_methods_router
from app.api.routes_projections import projections_router
from app.api.routes_projects import router as projects_router
from app.config import Settings, ensure_data_dir
from app.core.logging import get_logger, setup_logging
from app.core.security import LocalOnlyMiddleware
from app.jobs.manager import JobManager
from app.storage.projects_store import ProjectStore

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

    app = FastAPI(
        title="Embedding Space Explorer API",
        version=__version__,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = resolved
    app.state.project_store = ProjectStore(resolved.data_dir)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        ensure_data_dir(resolved)
        store: ProjectStore = application.state.project_store
        application.state.job_manager = JobManager(store)
        log.info(
            "backend %s started on %s:%d, data dir: %s",
            __version__,
            resolved.host,
            resolved.port,
            resolved.data_dir,
        )
        yield
        manager: JobManager = application.state.job_manager
        manager.shutdown()
        store.close_all()

    app.router.lifespan_context = lifespan

    install_error_handlers(app)

    # Order matters: middleware added later runs first (outermost).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(resolved),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(LocalOnlyMiddleware)

    app.include_router(health_router)
    app.include_router(projects_router)
    app.include_router(files_router)
    app.include_router(fragments_router)
    app.include_router(jobs_router)
    app.include_router(fs_router)
    app.include_router(models_router)
    app.include_router(preparation_router)
    app.include_router(embeddings_router)
    app.include_router(projection_methods_router)
    app.include_router(projections_router)
    return app


app = create_app()
