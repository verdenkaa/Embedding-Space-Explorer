"""Semantic neighbor endpoints (TZ §7.1).

Neighbors are ALWAYS computed over the ORIGINAL embeddings with an explicit
metric — never over projection coordinates (unless the user later explicitly
asks for that, which the MVP does not offer). Exact brute-force ranking over
the stored vectors; the response names the metric and the run so the UI can
show HOW the similarity was computed.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.api.deps import get_project
from app.api.errors import ApiError
from app.api.schemas import NeighborDTO, NeighborsRequest, NeighborsResponse
from app.neighbor_search.search import NeighborSearchError, knn
from app.storage.models import EmbeddingRunRow, FileRow, FragmentRow
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache

router = APIRouter(prefix="/api/projects/{project_id}", tags=["neighbors"])

#: SQLite bound-parameter safety margin for chunked IN(…) queries.
_META_CHUNK = 400


@router.post("/neighbors", response_model=NeighborsResponse)
def find_neighbors(
    ctx: Annotated[ProjectContext, Depends(get_project)],
    payload: NeighborsRequest,
) -> NeighborsResponse:
    with ctx.session_factory() as session:
        if payload.embedding_run_id is not None:
            run = session.get(EmbeddingRunRow, payload.embedding_run_id)
            if run is None:
                raise ApiError(
                    404,
                    "unknown_embedding_run",
                    f"Embedding run '{payload.embedding_run_id}' does not exist.",
                )
        else:
            run = session.execute(
                select(EmbeddingRunRow).order_by(EmbeddingRunRow.updated_at.desc()).limit(1)
            ).scalar_one_or_none()
            if run is None:
                raise ApiError(
                    409,
                    "no_embedding_run",
                    "The project has no embedding runs.",
                    "Compute embeddings first (EXPERIMENTS section).",
                )
        fragment = session.get(FragmentRow, payload.fragment_id)
        if fragment is None:
            raise ApiError(
                404,
                "fragment_not_found",
                f"Fragment '{payload.fragment_id}' does not exist in this project.",
            )
        run_id = run.id
        npz_relpath = run.npz_relpath

    cache = NpzEmbeddingCache.load(ctx.project_dir / npz_relpath)
    query_index = cache.index_of(payload.fragment_id)
    if query_index is None:
        raise ApiError(
            409,
            "no_vector_for_fragment",
            "This fragment has no vector in the selected embedding run.",
            "Compute (or recompute) embeddings to cover the fragment.",
        )

    try:
        hits = knn(cache.vectors, query_index, payload.k, payload.metric)
    except NeighborSearchError as exc:
        raise ApiError(400, "invalid_neighbor_params", str(exc)) from None

    wanted = [cache.ids[hit.index] for hit in hits]
    meta: dict[str, tuple[FragmentRow, str]] = {}
    with ctx.session_factory() as session:
        for start in range(0, len(wanted), _META_CHUNK):
            chunk = wanted[start : start + _META_CHUNK]
            rows = session.execute(
                select(FragmentRow, FileRow.rel_path)
                .join(FileRow, FileRow.id == FragmentRow.file_id)
                .where(FragmentRow.id.in_(chunk))
            ).all()
            for frag, rel_path in rows:
                meta[frag.id] = (frag, rel_path)

    neighbors: list[NeighborDTO] = []
    for hit in hits:
        fragment_id = cache.ids[hit.index]
        entry = meta.get(fragment_id)
        if entry is None:
            continue  # fragment deleted since the vectors were computed
        frag, rel_path = entry
        neighbors.append(
            NeighborDTO(
                fragment_id=fragment_id,
                file_id=frag.file_id,
                rel_path=rel_path,
                kind=frag.kind,
                name=frag.name,
                symbol_path=frag.symbol_path,
                start_line=frag.start_line,
                end_line=frag.end_line,
                distance=round(hit.distance, 6),
                score=round(hit.score, 6),
            )
        )

    return NeighborsResponse(
        fragment_id=payload.fragment_id,
        embedding_run_id=run_id,
        metric=payload.metric,
        k=payload.k,
        total_vectors=len(cache),
        neighbors=neighbors,
        note=(
            f"Соседи и сходство посчитаны по ИСХОДНЫМ эмбеддингам запуска "
            f"(метрика {payload.metric}), а не по координатам проекции."
        ),
    )
