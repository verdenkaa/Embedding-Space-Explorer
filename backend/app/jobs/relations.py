"""Relation extraction job: full re-extraction of surface relations.

Policy:
- extraction is IDEMPOTENT by full replace: rows with origin='extracted' are
  deleted and rebuilt from the CURRENT corpus (imported and manual relations
  are never touched — provenance separation);
- after a reindex the extracted set may be outdated (fragments changed):
  the UI says so and offers re-extraction; nothing is recomputed silently;
- unresolved import specifiers (third-party packages, dynamic paths) are
  counted and sampled into job warnings — they never become fake relations.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import delete, select

from app.jobs.manager import JobContext, JobRunner
from app.relation_providers.extract import extract_relations
from app.storage.models import FileRow, FragmentRow, RelationRow


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def make_relations_runner() -> JobRunner:
    def runner(ctx: JobContext) -> str:
        project = ctx.project

        ctx.progress(0, 4, "loading corpus", force=True)
        with project.session_factory() as session:
            files = list(
                session.execute(select(FileRow).where(FileRow.status == "indexed")).scalars().all()
            )
            fragments = list(session.execute(select(FragmentRow)).scalars().all())
        fragments_by_file: dict[str, list[FragmentRow]] = defaultdict(list)
        for frag in fragments:
            fragments_by_file[frag.file_id].append(frag)

        ctx.check_cancelled()
        ctx.progress(1, 4, f"extracting from {len(files)} indexed files", force=True)

        def progress(done: int, total: int) -> None:
            ctx.progress(done, total, f"parsing {done}/{total}")

        drafts, summary = extract_relations(files, fragments_by_file, progress=progress)

        ctx.check_cancelled()
        ctx.progress(2, 4, "persisting relations", force=True)
        now = _utc_now()
        with project.session_factory() as session:
            session.execute(delete(RelationRow).where(RelationRow.origin == "extracted"))
            for draft in drafts:
                session.add(
                    RelationRow(
                        id=uuid.uuid4().hex[:12],
                        source_file_id=draft.source_file_id,
                        source_fragment_id=draft.source_fragment_id,
                        target_file_id=draft.target_file_id,
                        target_fragment_id=draft.target_fragment_id,
                        kind=draft.kind,
                        origin="extracted",
                        confidence=1.0,  # deterministic parse, not a guess
                        detail=draft.detail,
                        created_at=now,
                    )
                )
            session.commit()

        if summary.imports_unresolved:
            samples = ", ".join(summary.unresolved_samples[:8])
            ctx.warn(
                f"{summary.imports_unresolved} import specifiers did not resolve to project "
                f"files (third-party packages or dynamic paths) and were NOT turned into "
                f"relations; examples: {samples}"
            )
        if summary.files_error:
            ctx.warn(f"{summary.files_error} files could not be read during extraction")

        ctx.progress(4, 4, "done", force=True)
        return (
            f"extracted {summary.imports_resolved} imports "
            f"({summary.imports_unresolved} unresolved) and {summary.belongs_to} belongs_to "
            f"over {summary.files_scanned} files"
        )

    return runner
