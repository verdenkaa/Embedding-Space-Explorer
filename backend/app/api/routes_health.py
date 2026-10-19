"""GET /api/health — backend diagnostics.

Reports application/runtime versions, data directory state, and the status of
every dependency the application relies on. A missing package is reported as
*not installed* instead of pretending to be ready.
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

# Distribution names the application relies on, and whether each is required.
RUNTIME_DEPENDENCIES: tuple[tuple[str, bool], ...] = (
    ("fastapi", True),
    ("pydantic", True),
    ("uvicorn", True),
    ("sqlalchemy", True),
    ("tree-sitter", True),
    ("tree-sitter-python", True),
    ("tree-sitter-javascript", True),
    ("tree-sitter-typescript", True),
    ("numpy", True),
    ("torch", True),
    ("sentence-transformers", True),
    ("scikit-learn", True),
    ("umap-learn", True),
    # Research notebooks: .ipynb format + persistent Python kernels.
    ("nbformat", True),
    ("jupyter_client", True),
    ("ipykernel", True),
    # Notebook plots (%matplotlib inline) — required by the pinned lock.
    ("matplotlib", True),
)


def detect_dependencies() -> list[DependencyInfo]:
    """Collect installed versions for every known runtime distribution."""
    infos: list[DependencyInfo] = []
    for name, required in RUNTIME_DEPENDENCIES:
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
