"""SQLAlchemy models for a project database (db schema v4).

Entities and ID rules are documented in docs/data-model.md.
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.storage.db import Base


class MetaRow(Base):
    __tablename__ = "meta"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(256))


class FileRow(Base):
    """One scanned source file. Identity: (root, rel_path) — stable file_id
    across rescans; content changes update the row, not the identity."""

    __tablename__ = "files"
    __table_args__ = (
        UniqueConstraint("root", "rel_path", name="uq_files_root_relpath"),
        Index("ix_files_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    root: Mapped[str] = mapped_column(String(1024))
    rel_path: Mapped[str] = mapped_column(String(1024))
    abs_path: Mapped[str] = mapped_column(String(2048))
    size: Mapped[int] = mapped_column(Integer, default=0)
    mtime: Mapped[float] = mapped_column(default=0.0)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    language: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: "indexed" | "skipped" | "error"
    status: Mapped[str] = mapped_column(String(16), default="indexed")
    skip_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    indexed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class FragmentRow(Base):
    """One code fragment. Primary key is the deterministic stable ID."""

    __tablename__ = "fragments"
    __table_args__ = (
        Index("ix_fragments_file", "file_id"),
        Index("ix_fragments_symbol_path", "symbol_path"),
    )

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    file_id: Mapped[str] = mapped_column(String(32), ForeignKey("files.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    symbol_path: Mapped[str] = mapped_column(String(1024))
    parent_symbol_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    start_line: Mapped[int] = mapped_column(Integer)
    end_line: Mapped[int] = mapped_column(Integer)
    start_offset: Mapped[int] = mapped_column(Integer)
    end_offset: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    method: Mapped[str] = mapped_column(String(64))
    language: Mapped[str] = mapped_column(String(32))
    ordinal: Mapped[int] = mapped_column(Integer, default=0)


class JobRow(Base):
    """A background task (index | model_download | embed | projection)."""

    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_created", "created_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    #: queued | running | done | failed | cancelled
    state: Mapped[str] = mapped_column(String(16), default="queued")
    progress_done: Mapped[int] = mapped_column(Integer, default=0)
    progress_total: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    error: Mapped[str | None] = mapped_column(String(4096), nullable=True)
    warnings_json: Mapped[str | None] = mapped_column(String(65536), nullable=True)
    params_json: Mapped[str | None] = mapped_column(String(65536), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40))
    started_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    finished_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class EmbeddingRunRow(Base):
    """One embedding run configuration + its vector cache file.

    Identity of a run = (model_id, mode, template, params_json): changing any
    of these creates a NEW run instead of silently mixing vectors (TZ §2.3).
    Vectors live in an .npz file next to the DB (see docs/data-model.md);
    this row is the inventory + pointer.
    """

    __tablename__ = "embedding_runs"
    __table_args__ = (Index("ix_emb_runs_project", "updated_at"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    model_id: Mapped[str] = mapped_column(String(256))
    dim: Mapped[int] = mapped_column(Integer, default=0)
    mode: Mapped[str] = mapped_column(String(32))
    template: Mapped[str] = mapped_column(String(2048))
    params_json: Mapped[str] = mapped_column(String(2048))
    npz_relpath: Mapped[str] = mapped_column(String(512))
    count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40))


class ProjectionRunRow(Base):
    """One projection run: method+params+seed over one embedding run.

    Identity = fingerprint(embedding_run, method, n_components, params, seed);
    coordinates live in a .npz file (cache/projections/). `source_signature`
    is the embedding cache signature at compute time: mismatch ⇒ the vectors
    changed since (recompute/prune/reindex) ⇒ the projection is STALE and the
    UI must say so instead of silently showing an outdated map (TZ §9.3).
    """

    __tablename__ = "projection_runs"
    __table_args__ = (Index("ix_proj_runs_emb", "embedding_run_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    embedding_run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("embedding_runs.id", ondelete="CASCADE")
    )
    method: Mapped[str] = mapped_column(String(32))
    n_components: Mapped[int] = mapped_column(Integer, default=3)
    params_json: Mapped[str] = mapped_column(String(2048))
    seed: Mapped[int] = mapped_column(Integer, default=0)
    axis_labels_json: Mapped[str] = mapped_column(String(512))
    #: PCA explained variance ratios (JSON list) or null (UMAP)
    axis_info_json: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    #: library versions that produced the coordinates (TZ §9.2)
    versions_json: Mapped[str] = mapped_column(String(512))
    npz_relpath: Mapped[str] = mapped_column(String(512))
    count: Mapped[int] = mapped_column(Integer, default=0)
    source_signature: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40))


class ProjectionPresetRow(Base):
    """A named, reusable projection form state (method + params + seed).

    Presets make found axis combinations/method settings returnable in one
    click (research workflow). They do NOT pin an embedding run: a preset is
    applied to whichever run the user selects. Names are unique per project.
    """

    __tablename__ = "projection_presets"
    __table_args__ = (UniqueConstraint("name", name="uq_proj_preset_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    method: Mapped[str] = mapped_column(String(32))
    params_json: Mapped[str] = mapped_column(String(2048))
    seed: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String(40))
