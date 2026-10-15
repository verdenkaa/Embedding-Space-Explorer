"""GET /api/health — backend diagnostics.

Reports application/runtime versions, data directory state, and the status of
every dependency the roadmap relies on. Dependencies planned for later stages
are reported as *not installed* with the stage that introduces them, instead of
pretending to be ready (TZ §17.2).
"""

from __future__ import annotations

import platform as platform_mod
import tempfile
from importlib import metadata
from typing import Annotated

from fastapi import APIRouter, Depends

from app import SCHEMA_VERSION, __version__
from app.api.deps import get_settings
from app.api.schemas import CheckResult, DependencyInfo, HealthResponse, OverallStatus
from app.config import APP_NAME, Settings

router = APIRouter(prefix="/api", tags=["health"])

# (distribution name, required now, stage that introduces it)
DEPENDENCY_PLAN: tuple[tuple[str, bool, str | None], ...] = (
    ("fastapi", True, None),
    ("pydantic", True, None),
    ("uvicorn", True, None),
    ("sqlalchemy", True, None),
    ("tree-sitter", True, None),
    ("tree-sitter-python", True, None),
    ("tree-sitter-javascript", True, None),
    ("tree-sitter-typescript", True, None),
    ("numpy", False, "stage-2"),
    ("torch", False, "stage-2"),
    ("sentence-transformers", False, "stage-2"),
    ("scikit-learn", False, "stage-3"),
    ("umap-learn", False, "stage-3"),
)


def detect_dependencies() -> list[DependencyInfo]:
    """Collect installed versions for every planned distribution."""
    infos: list[DependencyInfo] = []
    for name, required, stage in DEPENDENCY_PLAN:
        try:
            version: str | None = metadata.version(name)
            installed = True
        except metadata.PackageNotFoundError:
            version = None
            installed = False
        infos.append(
            DependencyInfo(
                name=name,
                installed=installed,
                version=version,
                required=required,
                planned_stage=stage,
            )
        )
    return infos


def check_data_dir(settings: Settings) -> CheckResult:
    """Verify that the data directory exists and accepts writes."""
    try:
        with tempfile.NamedTemporaryFile(dir=settings.data_dir, prefix=".health-"):
            pass
    except OSError as exc:
        return CheckResult(
            name="data_dir_writable",
            status="error",
            detail=f"{settings.data_dir}: {exc}",
        )
    return CheckResult(
        name="data_dir_writable",
        status="ok",
        detail=str(settings.data_dir),
    )


def check_loopback(settings: Settings) -> CheckResult:
    if settings.loopback_only:
        return CheckResult(
            name="loopback_binding",
            status="ok",
            detail=f"listening on {settings.host} only",
        )
    return CheckResult(
        name="loopback_binding",
        status="warn",
        detail=(
            f"host {settings.host} is reachable from the local network; "
            "set ESE_HOST=127.0.0.1 unless this is intentional"
        ),
    )


def check_required_dependencies(dependencies: list[DependencyInfo]) -> CheckResult:
    missing = [d.name for d in dependencies if d.required and not d.installed]
    if missing:
        return CheckResult(
            name="required_dependencies",
            status="error",
            detail=f"missing: {', '.join(missing)}; reinstall backend requirements",
        )
    return CheckResult(
        name="required_dependencies",
        status="ok",
        detail="all required packages installed",
    )


@router.get("/health", response_model=HealthResponse)
def get_health(
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthResponse:
    dependencies = detect_dependencies()
    checks = [
        check_data_dir(settings),
        check_loopback(settings),
        check_required_dependencies(dependencies),
    ]
    statuses = {c.status for c in checks}
    overall: OverallStatus
    if "error" in statuses:
        overall = "error"
    elif "warn" in statuses:
        overall = "degraded"
    else:
        overall = "ok"
    return HealthResponse(
        status=overall,
        app_name=APP_NAME,
        app_version=__version__,
        schema_version=SCHEMA_VERSION,
        python_version=platform_mod.python_version(),
        platform=platform_mod.platform(),
        server_host=settings.host,
        server_port=settings.port,
        loopback_only=settings.loopback_only,
        data_dir=str(settings.data_dir),
        dependencies=dependencies,
        checks=checks,
    )
