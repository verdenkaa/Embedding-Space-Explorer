"""Indexing job: scan → classify changes → re-fragment incrementally.

Only new/modified files are re-fragmented; unchanged files keep their rows,
fragments and (future) embedding caches. Deleted files — and files
that became excluded since the last index — lose their rows and fragments.
Skipped-file reasons are not persisted: the changes endpoint reports them
live from each scan (they are a property of the scan, not of the index).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, func, select

from app.fragmentation.registry import fragment_file
from app.jobs.embedding import prune_embedding_caches
from app.jobs.manager import JobContext
from app.source_registry.changes import (
    ChangesPlan,
    ExistingFileInfo,
    classify_changes,
    hash_file,
    read_text_safely,
)
from app.source_registry.scanner import ScanResult, scan_roots
from app.storage.models import FileRow, FragmentRow
from app.storage.projects_store import ProjectContext, write_manifest_atomic


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@dataclass
class IndexInputs:
    scan: ScanResult
    plan: ChangesPlan


def scan_project(project: ProjectContext) -> ScanResult:
    """Full scan of the project roots (same rules as indexing)."""
    manifest = project.manifest
    return scan_roots(manifest.roots, manifest.split_options)


def load_existing_files(project: ProjectContext) -> list[ExistingFileInfo]:
    with project.session_factory() as session:
        rows = session.execute(select(FileRow)).scalars().all()
        return [
            ExistingFileInfo(
                id=r.id,
                root=r.root,
                rel_path=r.rel_path,
                abs_path=r.abs_path,
                size=r.size,
                mtime=r.mtime,
                content_hash=r.content_hash,
                status=r.status,
            )
            for r in rows
        ]


def build_index_inputs(project: ProjectContext) -> IndexInputs:
    """Shared by GET /changes (preview) and the indexing job (apply)."""
    scan = scan_project(project)
    plan = classify_changes(scan, load_existing_files(project))
    return IndexInputs(scan=scan, plan=plan)


def compute_staleness(project: ProjectContext) -> IndexInputs:
    """Cheap staleness probe for the UI indicator: same scan, no hashing.

    May over-report (touch-only changes count as modified); the authoritative
    report is GET /changes, which verifies content hashes.
    """
    scan = scan_project(project)
    plan = classify_changes(scan, load_existing_files(project), verify_hashes=False)
    return IndexInputs(scan=scan, plan=plan)


def run_index_job(ctx: JobContext) -> str:
    project = ctx.project

    ctx.progress(0, 0, "scanning source roots", force=True)
    inputs = build_index_inputs(project)
    scan, plan = inputs.scan, inputs.plan

    for err in scan.root_errors:
        ctx.warn(f"root error: {err}")
    for warning in scan.warnings:
        ctx.warn(warning)

    total = len(plan.new) + len(plan.modified) + len(plan.deleted)
    ctx.progress(0, total, "preparing", force=True)

    done = 0
    with project.session_factory() as session:
        existing_by_key: dict[tuple[str, str], FileRow] = {
            (r.root, r.rel_path): r for r in session.execute(select(FileRow)).scalars().all()
        }

        # 1. Deleted (or newly excluded) files: drop rows and fragments.
        for deleted in plan.deleted:
            ctx.check_cancelled()
            row = existing_by_key.get((deleted.root, deleted.rel_path))
            if row is not None:
                session.execute(delete(FragmentRow).where(FragmentRow.file_id == row.id))
                session.delete(row)
                existing_by_key.pop((deleted.root, deleted.rel_path), None)
            done += 1
            ctx.progress(done, total, f"removed {deleted.rel_path}")

        # 2. New and modified files: read, hash, fragment, store.
        for change in [*plan.new, *plan.modified]:
            ctx.check_cancelled()
            key = (change.root, change.rel_path)
            row = existing_by_key.get(key)
            if row is None:
                row = FileRow(id=uuid.uuid4().hex[:12], root=change.root, rel_path=change.rel_path)
                session.add(row)
                existing_by_key[key] = row
            else:
                session.execute(delete(FragmentRow).where(FragmentRow.file_id == row.id))

            row.abs_path = change.abs_path
            row.size = change.size
            row.mtime = change.mtime
            row.language = change.language

            content_hash = hash_file(change.abs_path)
            text, read_error = read_text_safely(change.abs_path)
            if content_hash is None or text is None:
                row.status = "error"
                row.content_hash = None
                row.detail = read_error or "cannot read file"
                row.indexed_at = _utc_now()
                ctx.warn(f"{change.rel_path}: {row.detail}")
                done += 1
                ctx.progress(done, total, f"error: {change.rel_path}")
                continue

            result = fragment_file(
                rel_path=change.rel_path,
                text=text,
                options=project.manifest.split_options,
            )
            for warning in result.warnings:
                ctx.warn(f"{change.rel_path}: {warning}")

            row.status = "indexed"
            row.content_hash = content_hash
            row.detail = None
            row.skip_reason = None
            row.indexed_at = _utc_now()

            for frag in result.fragments:
                session.add(
                    FragmentRow(
                        id=frag.fragment_id,
                        file_id=row.id,
                        kind=frag.kind,
                        name=frag.name,
                        symbol_path=frag.symbol_path,
                        parent_symbol_path=frag.parent_symbol_path,
                        start_line=frag.start_line,
                        end_line=frag.end_line,
                        start_offset=frag.start_offset,
                        end_offset=frag.end_offset,
                        content_hash=frag.content_hash,
                        method=frag.method,
                        language=frag.language,
                        ordinal=frag.ordinal,
                    )
                )

            done += 1
            ctx.progress(done, total, f"indexed {change.rel_path}")
            if done % 10 == 0:
                session.commit()

        session.commit()
        total_fragments = session.execute(select(func.count(FragmentRow.id))).scalar_one()

    # Embedding caches must not keep vectors of deleted/changed fragments.
    prune_embedding_caches(project, ctx.warn)

    # Force-flush the final progress so the finished job shows 100%.
    ctx.progress(total, total, "finalizing", force=True)

    project.manifest.updated_at = _utc_now()
    write_manifest_atomic(project.project_dir / "project.json", project.manifest)

    return (
        f"index complete: {len(plan.new)} new, {len(plan.modified)} modified, "
        f"{len(plan.deleted)} deleted, {plan.unchanged_count} unchanged; "
        f"{total_fragments} fragments in project"
    )
