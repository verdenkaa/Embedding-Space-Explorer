"""Embedding jobs: model download and vector computation.

Design notes:
- CPU-only, batched; batch size defaults are conservative for 8 GB machines.
- Cancellation between batches KEEPS already-computed vectors (checkpointed
  .npz), so a retry continues instead of restarting.
- Cache key = sha256(exact prepared text) within a run identified by
  (model, mode, template, params fingerprint). Runs are never mixed.
- Index jobs prune caches (deleted/changed fragments lose stale vectors).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy import select

from app.embedding_providers.base import ModelNotDownloadedError, params_fingerprint
from app.embedding_providers.preparation import (
    CONTEXT_TEMPLATE,
    VALID_MODES,
    FragmentText,
    prepare_text,
    prepared_text_hash,
)
from app.embedding_providers.registry import create_provider, get_model_info
from app.jobs.manager import JobContext, JobRunner
from app.source_registry.changes import read_text_safely
from app.storage.models import EmbeddingRunRow, FileRow, FragmentRow
from app.storage.projects_store import ProjectContext
from app.vector_store.npz_cache import NpzEmbeddingCache


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def make_download_runner(model_id: str) -> JobRunner:
    def runner(ctx: JobContext) -> str:
        provider = create_provider(model_id, ctx.project.data_dir)

        def report(message: str) -> None:
            ctx.progress(0, 0, message, force=True)

        provider.download(progress_message=report)
        return f"model '{model_id}' cached in {ctx.project.data_dir / 'models'}"

    return runner


def run_params() -> dict[str, object]:
    """Parameters that INFLUENCE THE VECTORS (run identity / cache key).

    batch_size is deliberately NOT here: it is an execution detail and must
    not invalidate cached vectors (lowering batch size on low RAM
    restarts the stage without losing cached results).
    """
    return {"normalize": True, "device": "cpu", "dtype": "float32"}


def make_embed_runner(model_id: str, mode: str, batch_size: int) -> JobRunner:
    def runner(ctx: JobContext) -> str:
        project = ctx.project

        info = get_model_info(model_id)
        if info is None:
            raise ValueError(f"unknown model_id: {model_id!r}")
        if mode not in VALID_MODES:
            raise ValueError(f"unknown preparation mode: {mode!r}")

        provider = create_provider(model_id, project.data_dir)
        if not provider.is_downloaded():
            raise ModelNotDownloadedError(
                f"model '{info.display_name}' is not downloaded; run «Скачать модель» first"
            )

        template = CONTEXT_TEMPLATE
        params = run_params()
        fingerprint = params_fingerprint(model_id, mode, template, params)
        npz_relpath = f"cache/embeddings/{fingerprint}.npz"
        npz_path = project.project_dir / npz_relpath

        with project.session_factory() as session:
            run = session.get(EmbeddingRunRow, fingerprint)
            if run is None:
                run = EmbeddingRunRow(
                    id=fingerprint,
                    model_id=model_id,
                    dim=0,
                    mode=mode,
                    template=template,
                    params_json=json.dumps(params, sort_keys=True),
                    npz_relpath=npz_relpath,
                    count=0,
                    created_at=_utc_now(),
                    updated_at=_utc_now(),
                )
                session.add(run)
                session.commit()
            rows = session.execute(
                select(FragmentRow, FileRow.rel_path, FileRow.abs_path)
                .join(FileRow, FileRow.id == FragmentRow.file_id)
                .where(FileRow.status == "indexed")
                .order_by(FragmentRow.file_id, FragmentRow.start_line)
            ).all()

        cache = NpzEmbeddingCache.load(npz_path)
        valid_hashes = {frow.id: frow.content_hash for frow, _, _ in rows}
        pruned = cache.prune(valid_hashes)

        # Build the exact prepared texts; skip anything already cached.
        file_texts: dict[str, str | None] = {}
        todos: list[tuple[str, str, str, str]] = []  # (frag_id, frag_hash, prepared, text_hash)
        for frow, rel_path, abs_path in rows:
            if abs_path not in file_texts:
                file_texts[abs_path] = read_text_safely(abs_path)[0]
            text = file_texts[abs_path]
            if text is None:
                ctx.warn(f"cannot read '{rel_path}'; its fragments are skipped")
                continue
            lines = text.split("\n")
            fragment_text = "\n".join(lines[frow.start_line - 1 : frow.end_line])
            prepared = prepare_text(
                FragmentText(
                    text=fragment_text,
                    rel_path=rel_path,
                    symbol_path=frow.symbol_path,
                    kind=frow.kind,
                    parent_symbol_path=frow.parent_symbol_path,
                    language=frow.language,
                ),
                mode,
                template,
            )
            text_hash = prepared_text_hash(prepared)
            if cache.text_hash_of(frow.id) == text_hash:
                continue  # already embedded with the exact same prepared text
            todos.append((frow.id, frow.content_hash, prepared, text_hash))

        total = len(todos)
        cached_count = len(rows) - total
        ctx.progress(0, total, f"to embed: {total}, cached: {cached_count}", force=True)

        done = 0
        checkpoint_every = max(batch_size * 10, 32)
        try:
            for start in range(0, total, batch_size):
                ctx.check_cancelled()
                chunk = todos[start : start + batch_size]
                vectors = provider.encode(
                    [c[2] for c in chunk],
                    batch_size=len(chunk),
                    normalize=bool(params["normalize"]),
                )
                cache.upsert(
                    [c[0] for c in chunk],
                    [c[3] for c in chunk],
                    [c[1] for c in chunk],
                    vectors,
                )
                done += len(chunk)
                ctx.progress(done, total, f"embedded {done}/{total}")
                if done % checkpoint_every < batch_size:
                    cache.save()
        finally:
            # Keep partial results on cancellation/failure (checkpointing).
            _finalize_run(project, fingerprint, cache)

        if pruned:
            ctx.warn(f"pruned {pruned} stale/deleted vectors before computing")
        return (
            f"embedded {done} vectors, {cached_count} reused from cache; "
            f"run total {len(cache)} (dim {cache.dim}), mode '{mode}'"
        )

    return runner


def _finalize_run(project: ProjectContext, fingerprint: str, cache: NpzEmbeddingCache) -> None:
    cache.save()
    with project.session_factory() as session:
        run = session.get(EmbeddingRunRow, fingerprint)
        if run is not None:
            run.count = len(cache)
            run.dim = cache.dim
            run.updated_at = _utc_now()
            session.commit()


def prune_embedding_caches(project: ProjectContext, warn: Callable[[str], None]) -> None:
    """Drop vectors of deleted/changed fragments after (re)indexing."""
    with project.session_factory() as session:
        runs = session.execute(select(EmbeddingRunRow)).scalars().all()
        if not runs:
            return
        valid = dict(session.execute(select(FragmentRow.id, FragmentRow.content_hash)).all())
        for run in runs:
            cache = NpzEmbeddingCache.load(project.project_dir / run.npz_relpath)
            removed = cache.prune(valid)
            if removed:
                _finalize_run(project, run.id, cache)
                warn(f"embedding run {run.id}: pruned {removed} stale vectors after reindex")
