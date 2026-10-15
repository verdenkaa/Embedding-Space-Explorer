"""Pydantic DTOs for the HTTP API.

Error envelope used by every endpoint and by the security middleware:

    {"error": {"code": str, "message": str, "hint": str | null}}
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

CheckStatus = Literal["ok", "warn", "error"]
OverallStatus = Literal["ok", "degraded", "error"]


class ErrorDetail(BaseModel):
    """Machine-readable error code plus a human-facing message and next step."""

    code: str
    message: str
    hint: str | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail


class DependencyInfo(BaseModel):
    """A runtime dependency: installed version or the stage where it is planned."""

    name: str
    installed: bool
    version: str | None = None
    required: bool
    planned_stage: str | None = Field(
        default=None,
        description="Development stage that introduces this dependency, e.g. 'stage-2'.",
    )


class CheckResult(BaseModel):
    """A single diagnostic check with a non-color-only status."""

    name: str
    status: CheckStatus
    detail: str


class HealthResponse(BaseModel):
    """Full backend diagnostics payload for GET /api/health."""

    status: OverallStatus
    app_name: str
    app_version: str
    schema_version: int
    python_version: str
    platform: str
    server_host: str
    server_port: int
    loopback_only: bool
    data_dir: str
    dependencies: list[DependencyInfo]
    checks: list[CheckResult]
