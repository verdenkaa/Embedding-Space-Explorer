"""Experiment endpoints (TZ §9.2, §10.1): save / list / open / delete.

Saving validates every reference (unknown runs or groups are rejected with
the exact list) and records an interpretation snapshot AT SAVE TIME. Opening
(detail) recomputes live status: what disappeared or went stale is reported,
never silently substituted. Comparison is done client-side from two configs
(the API provides everything needed).
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.schemas import (
    CreateExperimentRequest,
    ExperimentDTO,
    ExperimentLiveStatusDTO,
    ExperimentSummaryDTO,
)
from app.experiment_manager.manager import (
    build_live_status,
    build_snapshot,
    build_summary,
    validate_references,
)
from app.storage.models import ExperimentRow
from app.storage.projects_store import ProjectContext

router = APIRouter(prefix="/api/projects/{project_id}", tags=["experiments"])


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _to_dto(row: ExperimentRow, live_status: dict[str, Any] | None = None) -> ExperimentDTO:
    config = json.loads(row.config_json)
    snapshot = json.loads(row.snapshot_json)
    return ExperimentDTO(
        id=row.id,
        name=row.name,
        description=row.description,
        config=config,
        snapshot=snapshot,
        live_status=(
            ExperimentLiveStatusDTO(
                missing=live_status.get("missing", {}), stale=live_status.get("stale", {})
            )
            if live_status is not None
            else None
        ),
        created_at=row.created_at,
    )


@router.post("/experiments", response_model=ExperimentDTO, status_code=201)
def save_experiment(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: CreateExperimentRequest,
) -> ExperimentDTO:
    config = payload.config.model_dump(mode="json")

    missing, valid_selection = validate_references(ctx, config)
    if missing:
        detail = ", ".join(f"{field}: {', '.join(ids)}" for field, ids in sorted(missing.items()))
        raise ApiError(
            400,
            "experiment_refs_missing",
            f"The experiment references entities that no longer exist ({detail}).",
            "Remove or replace them in the current view, then save again.",
        )
    dropped = len(config.get("selection") or []) - len(valid_selection)
    config["selection"] = valid_selection

    snapshot = build_snapshot(ctx, config)
    if dropped > 0:
        snapshot["selection_dropped_at_save"] = dropped
    summary = build_summary(config, snapshot)
    snapshot["summary"] = summary

    row = ExperimentRow(
        id=uuid.uuid4().hex[:12],
        name=payload.name.strip(),
        description=(payload.description or "").strip() or None,
        config_json=json.dumps(config, ensure_ascii=False),
        snapshot_json=json.dumps(snapshot, ensure_ascii=False),
        created_at=_utc_now(),
    )
    with ctx.session_factory() as session:
        session.add(row)
        try:
            session.commit()
        except IntegrityError as exc:
            session.rollback()
            raise ApiError(
                409,
                "experiment_name_taken",
                f"An experiment named '{row.name}' already exists.",
                "Choose a different name.",
            ) from exc
    return _to_dto(row)


@router.get("/experiments", response_model=list[ExperimentSummaryDTO])
def list_experiments(
    ctx: Annotated[ProjectContext, Depends(get_project)],
) -> list[ExperimentSummaryDTO]:
    with ctx.session_factory() as session:
        rows = session.execute(select(ExperimentRow)).scalars().all()
    result = [
        ExperimentSummaryDTO(
            id=row.id,
            name=row.name,
            description=row.description,
            created_at=row.created_at,
            summary=json.loads(row.snapshot_json).get("summary") or {},
        )
        for row in rows
    ]
    result.sort(key=lambda e: (e.created_at, e.id), reverse=True)
    return result


@router.get("/experiments/{experiment_id}", response_model=ExperimentDTO)
def get_experiment(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    experiment_id: str,
) -> ExperimentDTO:
    with ctx.session_factory() as session:
        row = session.get(ExperimentRow, experiment_id)
    if row is None:
        raise ApiError(404, "experiment_not_found", f"Experiment '{experiment_id}' does not exist.")
    config = json.loads(row.config_json)
    return _to_dto(row, build_live_status(ctx, config))


@router.delete("/experiments/{experiment_id}")
def delete_experiment(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    experiment_id: str,
) -> dict[str, str]:
    with ctx.session_factory() as session:
        row = session.get(ExperimentRow, experiment_id)
        if row is None:
            raise ApiError(
                404, "experiment_not_found", f"Experiment '{experiment_id}' does not exist."
            )
        session.delete(row)
        session.commit()
    return {"deleted": experiment_id}
