"""Project store: create/open/list/delete research projects (TZ §9.1).

On-disk layout (per project):

    <data_dir>/projects/<id>/
        project.json         manifest (atomic writes)
        project.db           SQLite: files, fragments, jobs, meta
        cache/{fragments,embeddings,projections,neighbors,clustering}/
        experiments/
        exports/
        logs/

Corrupted manifests never break the global project list: such entries are
reported with an `error` field instead of raising (TZ §9.4).
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app import SCHEMA_VERSION, __version__
from app.fragmentation.base import SplitOptions
from app.source_registry.scanner import RootResolver
from app.storage.db import ProjectSchemaError, open_database


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class ProjectManifest(BaseModel):
    schema_version: int
    app_version: str
    id: str
    name: str
    created_at: str
    updated_at: str
    roots: list[str] = Field(default_factory=list)
    split_options: SplitOptions = Field(default_factory=SplitOptions)


@dataclass
class ProjectSummary:
    id: str
    name: str
    updated_at: str
    roots: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class ProjectContext:
    """An open project: manifest + database handles."""

    manifest: ProjectManifest
    project_dir: Path
    engine: Engine
    session_factory: sessionmaker[Session]
    #: Application data root (models cache lives in <data_dir>/models).
    data_dir: Path

    @property
    def id(self) -> str:
        return self.manifest.id


class ProjectNotFoundError(KeyError):
    pass


class ProjectValidationError(ValueError):
    pass


def write_manifest_atomic(path: Path, manifest: ProjectManifest) -> None:
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    os.replace(tmp, path)


class ProjectStore:
    """Manages projects under one data directory; caches open databases."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.projects_dir = data_dir / "projects"
        self._open: dict[str, ProjectContext] = {}
        self._lock = threading.Lock()

    # -- lifecycle -----------------------------------------------------------

    def create_project(
        self,
        name: str,
        roots: list[str],
        split_options: SplitOptions | None = None,
    ) -> ProjectContext:
        if not name.strip():
            raise ProjectValidationError("project name must not be empty")
        if not roots:
            raise ProjectValidationError("at least one source root is required")
        options = split_options or SplitOptions()
        resolver = RootResolver(roots, options)
        if resolver.errors:
            raise ProjectValidationError("; ".join(resolver.errors))

        project_id = uuid.uuid4().hex[:12]
        now = _utc_now()
        manifest = ProjectManifest(
            schema_version=SCHEMA_VERSION,
            app_version=__version__,
            id=project_id,
            name=name.strip(),
            created_at=now,
            updated_at=now,
            roots=[str(p) for p in resolver.resolved],
            split_options=options,
        )
        project_dir = self.projects_dir / project_id
        if project_dir.exists():  # pragma: no cover - uuid collision
            raise ProjectValidationError("project directory already exists")
        for sub in (
            "cache/fragments",
            "cache/embeddings",
            "cache/projections",
            "cache/neighbors",
            "cache/clustering",
            "experiments",
            "exports",
            "logs",
        ):
            (project_dir / sub).mkdir(parents=True, exist_ok=True)
        write_manifest_atomic(project_dir / "project.json", manifest)

        engine, factory = open_database(project_dir / "project.db")
        ctx = ProjectContext(
            manifest=manifest,
            project_dir=project_dir,
            engine=engine,
            session_factory=factory,
            data_dir=self.data_dir,
        )
        with self._lock:
            self._open[project_id] = ctx
        return ctx

    def list_projects(self) -> list[ProjectSummary]:
        if not self.projects_dir.exists():
            return []
        summaries: list[ProjectSummary] = []
        for entry in sorted(self.projects_dir.iterdir()):
            if not entry.is_dir():
                continue
            manifest_path = entry / "project.json"
            if not manifest_path.exists():
                summaries.append(
                    ProjectSummary(
                        id=entry.name, name=entry.name, updated_at="", error="manifest missing"
                    )
                )
                continue
            try:
                manifest = ProjectManifest.model_validate_json(manifest_path.read_text("utf-8"))
                summaries.append(
                    ProjectSummary(
                        id=manifest.id,
                        name=manifest.name,
                        updated_at=manifest.updated_at,
                        roots=manifest.roots,
                    )
                )
            except (ValidationError, OSError, json.JSONDecodeError) as exc:
                summaries.append(
                    ProjectSummary(
                        id=entry.name,
                        name=entry.name,
                        updated_at="",
                        error=f"corrupted manifest: {exc.__class__.__name__}",
                    )
                )
        return summaries

    def open(self, project_id: str) -> ProjectContext:
        with self._lock:
            cached = self._open.get(project_id)
        if cached is not None:
            return cached
        project_dir = self.projects_dir / project_id
        manifest_path = project_dir / "project.json"
        if not manifest_path.exists():
            raise ProjectNotFoundError(project_id)
        try:
            manifest = ProjectManifest.model_validate_json(manifest_path.read_text("utf-8"))
        except (ValidationError, OSError, json.JSONDecodeError) as exc:
            raise ProjectValidationError(f"corrupted manifest for {project_id}: {exc}") from exc
        engine, factory = open_database(project_dir / "project.db")
        ctx = ProjectContext(
            manifest=manifest,
            project_dir=project_dir,
            engine=engine,
            session_factory=factory,
            data_dir=self.data_dir,
        )
        with self._lock:
            self._open[project_id] = ctx
        return ctx

    def touch(self, ctx: ProjectContext) -> None:
        ctx.manifest.updated_at = _utc_now()
        write_manifest_atomic(ctx.project_dir / "project.json", ctx.manifest)

    def delete(self, project_id: str) -> None:
        with self._lock:
            ctx = self._open.pop(project_id, None)
        if ctx is not None:
            ctx.engine.dispose()
        project_dir = self.projects_dir / project_id
        if not project_dir.exists():
            raise ProjectNotFoundError(project_id)
        shutil.rmtree(project_dir)

    def close_all(self) -> None:
        with self._lock:
            for ctx in self._open.values():
                ctx.engine.dispose()
            self._open.clear()


def resolve_safe_under_roots(abs_path: str, roots: list[str]) -> Path | None:
    """Resolve a stored path and verify it still lives under a project root.

    Returns None when the path escapes the roots (moved root, symlink tricks,
    tampered values). Used by every endpoint that reads file content.
    """
    try:
        resolved = Path(abs_path).resolve()
    except OSError:
        return None
    for root in roots:
        try:
            root_resolved = Path(root).resolve()
        except OSError:
            continue
        try:
            if resolved.is_relative_to(root_resolved):
                return resolved
        except ValueError:
            continue
    return None


__all__ = [
    "ProjectContext",
    "ProjectManifest",
    "ProjectNotFoundError",
    "ProjectSchemaError",
    "ProjectStore",
    "ProjectValidationError",
    "resolve_safe_under_roots",
]
