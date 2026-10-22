"""Export endpoints: coordinates, metadata, relations, metrics
and experiments as downloadable files.

Every export is an explicit user action over an explicit target (a projection
run, the current relation filters, a listed selection, a metric run, an
experiment) — nothing is exported "in the background". Files carry the
identifiers and parameters needed to interpret them (§18.15). Scene images
(PNG) are captured client-side from the live canvas.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.routes_experiments import _to_dto as experiment_to_dto
from app.api.routes_metrics import _parse_run as metric_parse_run
from app.api.routes_projections import current_embedding_signature, get_projection_points
from app.api.routes_relations import _endpoint_dto, _load_endpoint_maps
from app.api.schemas import ExportFragmentsRequest
from app.experiment_manager.manager import build_live_status
from app.exporters.builders import fragments_csv, points_csv, relations_csv
from app.storage.models import (
    ExperimentRow,
    FileRow,
    FragmentRow,
    MetricRunRow,
    RelationRow,
)
from app.storage.projects_store import ProjectContext

router = APIRouter(prefix="/api/projects/{project_id}", tags=["exports"])

#: Honest cap: exports are for interpretation, not bulk dumps of the DB.
RELATIONS_EXPORT_CAP = 100_000


def _file_response(content: str, filename: str, media_type: str) -> Response:
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _json_response(payload: dict[str, Any], filename: str) -> Response:
    return _file_response(
        json.dumps(payload, ensure_ascii=False, indent=2), filename, "application/json"
    )


@router.get("/exports/projection/{projection_id}/points")
def export_projection_points(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    projection_id: str,
    format: Literal["csv", "json"] = "csv",
) -> Response:
    """All points of a projection run: coordinates + metadata + staleness."""
    dto = get_projection_points(ctx, projection_id)
    if format == "json":
        return _json_response(
            dto.model_dump(mode="json"), f"projection_{projection_id}_points.json"
        )
    points = [p.model_dump(mode="json") for p in dto.points]
    content = points_csv(points, dto.axis_labels)
    return _file_response(
        content, f"projection_{projection_id}_points.csv", "text/csv; charset=utf-8"
    )


@router.get("/exports/relations")
def export_relations(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    kind: str | None = None,
    origin: str | None = None,
    fragment_id: str | None = None,
    format: Literal["csv", "json"] = "csv",
) -> Response:
    """Relations matching the browser filters (endpoints resolved to paths)."""
    with ctx.session_factory() as session:
        stmt = select(RelationRow)
        if kind:
            stmt = stmt.where(RelationRow.kind == kind)
        if origin:
            stmt = stmt.where(RelationRow.origin == origin)
        if fragment_id:
            stmt = stmt.where(
                (RelationRow.source_fragment_id == fragment_id)
                | (RelationRow.target_fragment_id == fragment_id)
            )
        # The cap lives IN THE SQL: reading the whole table into Python and
        # slicing afterwards can OOM the backend on large corpora — the export
        # must never materialize more rows than it will actually serve.
        stmt = stmt.order_by(RelationRow.kind, RelationRow.id).limit(RELATIONS_EXPORT_CAP)
        rows = list(session.execute(stmt).scalars())
        frags, files = _load_endpoint_maps(session, rows)

        def endpoint_dict(row: RelationRow) -> dict[str, Any]:
            source = _endpoint_dto(row.source_file_id, row.source_fragment_id, frags, files)
            target = _endpoint_dto(row.target_file_id, row.target_fragment_id, frags, files)
            return {
                "id": row.id,
                "kind": row.kind,
                "origin": row.origin,
                "confidence": row.confidence,
                "detail": row.detail,
                "source_file": source.rel_path if source else None,
                "source_symbol": source.symbol_path if source else None,
                "source_start_line": source.start_line if source else None,
                "source_end_line": source.end_line if source else None,
                "source_fragment_id": row.source_fragment_id,
                "target_file": target.rel_path if target else None,
                "target_symbol": target.symbol_path if target else None,
                "target_start_line": target.start_line if target else None,
                "target_end_line": target.end_line if target else None,
                "target_fragment_id": row.target_fragment_id,
            }

        records = [endpoint_dict(row) for row in rows]
    if format == "json":
        return _json_response({"relations": records, "count": len(records)}, "relations.json")
    return _file_response(relations_csv(records), "relations.csv", "text/csv; charset=utf-8")


@router.post("/exports/fragments")
def export_fragments(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: ExportFragmentsRequest,
) -> Response:
    """Metadata of an explicit selection (ids ≤ 20 000)."""
    ids = list(dict.fromkeys(payload.fragment_ids))
    with ctx.session_factory() as session:
        rows: list[FragmentRow] = []
        for start in range(0, len(ids), 400):
            chunk = ids[start : start + 400]
            rows.extend(
                session.execute(select(FragmentRow).where(FragmentRow.id.in_(chunk))).scalars()
            )
        by_id = {row.id: row for row in rows}
        file_ids = {row.file_id for row in rows}
        file_paths: dict[str, str] = {}
        if file_ids:
            for file_row in session.execute(
                select(FileRow).where(FileRow.id.in_(file_ids))
            ).scalars():
                file_paths[file_row.id] = file_row.rel_path

    records: list[dict[str, Any]] = []
    missing = 0
    for fid in ids:
        row = by_id.get(fid)
        if row is None:
            missing += 1
            records.append({"fragment_id": fid})
            continue
        records.append(
            {
                "fragment_id": row.id,
                "rel_path": file_paths.get(row.file_id),
                "kind": row.kind,
                "name": row.name,
                "symbol_path": row.symbol_path,
                "parent_symbol_path": row.parent_symbol_path,
                "start_line": row.start_line,
                "end_line": row.end_line,
                "method": row.method,
                "language": row.language,
            }
        )
    response = _file_response(fragments_csv(records), "selection.csv", "text/csv; charset=utf-8")
    if missing:
        response.headers["X-Ese-Missing-Fragments"] = str(missing)
    return response


@router.get("/exports/metrics/{metric_id}")
def export_metric_run(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    metric_id: str,
) -> Response:
    """A metric run with params, results, explanations and versions."""
    with ctx.session_factory() as session:
        row = session.get(MetricRunRow, metric_id)
    if row is None:
        raise ApiError(404, "metric_run_not_found", f"Metric run '{metric_id}' does not exist.")
    current = current_embedding_signature(ctx, row.embedding_run_id)
    dto = metric_parse_run(row, stale=current is None or current != row.source_signature)
    return _json_response(dto.model_dump(mode="json"), f"metrics_{metric_id}.json")


@router.get("/exports/experiments/{experiment_id}")
def export_experiment(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    experiment_id: str,
) -> Response:
    """The full experiment: config, save-time snapshot and live status."""
    with ctx.session_factory() as session:
        row = session.get(ExperimentRow, experiment_id)
    if row is None:
        raise ApiError(404, "experiment_not_found", f"Experiment '{experiment_id}' does not exist.")
    config = json.loads(row.config_json)
    dto = experiment_to_dto(row, build_live_status(ctx, config))
    return _json_response(dto.model_dump(mode="json"), f"experiment_{row.name}.json")
