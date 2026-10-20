"""Row → DTO serialization helpers shared by routers."""

from __future__ import annotations

import json
from typing import Any

from app.api.schemas import JobInfo
from app.storage.models import JobRow


def job_info_from_row(row: JobRow) -> JobInfo:
    warnings: list[str] = []
    if row.warnings_json:
        try:
            warnings = json.loads(row.warnings_json)
        except json.JSONDecodeError:  # pragma: no cover - defensive
            warnings = ["<unparseable warnings>"]
    result: dict[str, Any] | None = None
    if row.result_json:
        try:
            parsed = json.loads(row.result_json)
            if isinstance(parsed, dict):
                result = parsed
        except json.JSONDecodeError:  # pragma: no cover - defensive
            result = None
    return JobInfo(
        id=row.id,
        kind=row.kind,
        state=row.state,  # type: ignore[arg-type]
        progress_done=row.progress_done,
        progress_total=row.progress_total,
        message=row.message,
        error=row.error,
        warnings=warnings,
        result=result,
        created_at=row.created_at,
        started_at=row.started_at,
        finished_at=row.finished_at,
    )
