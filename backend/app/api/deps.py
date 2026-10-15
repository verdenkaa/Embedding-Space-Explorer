"""Shared FastAPI dependencies for API routes."""

from __future__ import annotations

from fastapi import Request
from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.config import Settings
from app.jobs.manager import JobManager
from app.storage.db import ProjectSchemaError
from app.storage.projects_store import (
    ProjectContext,
    ProjectNotFoundError,
    ProjectStore,
    ProjectValidationError,
)


def get_settings(request: Request) -> Settings:
    """Return the settings resolved at application startup."""
    settings: Settings = request.app.state.settings
    return settings


def get_project_store(request: Request) -> ProjectStore:
    store: ProjectStore = request.app.state.project_store
    return store


def get_job_manager(request: Request) -> JobManager:
    manager: JobManager = request.app.state.job_manager
    return manager


def get_project(request: Request, project_id: str) -> ProjectContext:
    """Open (cached) project context or raise a structured API error."""
    store = get_project_store(request)
    try:
        return store.open(project_id)
    except ProjectNotFoundError:
        raise ApiError(
            404, "project_not_found", f"Project '{project_id}' does not exist."
        ) from None
    except ProjectSchemaError as exc:
        raise ApiError(
            409,
            "project_schema_incompatible",
            str(exc),
            "The project was created by a newer version of the application.",
        ) from None
    except ProjectValidationError as exc:
        raise ApiError(
            409,
            "project_corrupted",
            str(exc),
            "The project manifest is damaged; its data can still be exported manually "
            "from the project directory.",
        ) from None


def get_session(project: ProjectContext) -> Session:
    return project.session_factory()
