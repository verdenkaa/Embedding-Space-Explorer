"""SQLAlchemy models for a project database (db schema v6).

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
    #: structured result of a DONE job (e.g. {"projection_run_ids": [...]}):
    #: lets clients reference produced artifacts exactly instead of guessing
    #: from the human-readable message (schema v7)
    result_json: Mapped[str | None] = mapped_column(String(65536), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40))
    started_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    finished_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class EmbeddingRunRow(Base):
    """One embedding run configuration + its vector cache file.

    Identity of a run = (model_id, mode, template, params_json): changing any
    of these creates a NEW run instead of silently mixing vectors.
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
    #: how many cached vectors were computed from text LONGER than the
    #: model's max_seq_length (silently truncated by the tokenizer) — the
    #: per-vector detail lives in the .npz cache (schema v7)
    truncated_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40))


class ProjectionRunRow(Base):
    """One projection run: method+params+seed over one embedding run.

    Identity = fingerprint(embedding_run, method, n_components, params, seed);
    coordinates live in a .npz file (cache/projections/). `source_signature`
    is the embedding cache signature at compute time: mismatch ⇒ the vectors
    changed since (recompute/prune/reindex) ⇒ the projection is STALE and the
    UI must say so instead of silently showing an outdated map.
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
    #: library versions that produced the coordinates
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


class RelationRow(Base):
    """One structural relation: imports/calls/belongs_to/tested_by…

    Endpoints are files AND/OR fragments — an import at the top of a file
    belongs to no fragment, so file-level endpoints are honest first-class
    citizens (at least one endpoint object on each side is required; code
    enforces it). `origin` separates automatically extracted, imported and
    manual relations (never mix provenance).
    """

    __tablename__ = "relations"
    __table_args__ = (
        Index("ix_relations_source_fragment", "source_fragment_id"),
        Index("ix_relations_target_fragment", "target_fragment_id"),
        Index("ix_relations_kind", "kind"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    source_file_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("files.id", ondelete="CASCADE"), nullable=True
    )
    source_fragment_id: Mapped[str | None] = mapped_column(
        String(16), ForeignKey("fragments.id", ondelete="CASCADE"), nullable=True
    )
    target_file_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("files.id", ondelete="CASCADE"), nullable=True
    )
    target_fragment_id: Mapped[str | None] = mapped_column(
        String(16), ForeignKey("fragments.id", ondelete="CASCADE"), nullable=True
    )
    #: imports | calls | belongs_to | tested_by | tests | documents | …
    kind: Mapped[str] = mapped_column(String(32))
    #: extracted | imported | manual
    origin: Mapped[str] = mapped_column(String(16), default="extracted")
    confidence: Mapped[float | None] = mapped_column(nullable=True)
    detail: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[str] = mapped_column(String(40))


class ClusteringRunRow(Base):
    """One automatic clustering run.

    Identity = fingerprint(embedding_run, space, projection_run, algorithm,
    params); labels live in cache/clustering/<id>.npz (ids + int32 labels,
    -1 = noise). The space is EXPLICIT ("original" vectors or one projection
    run) and stored — the UI must show which one produced the clusters.
    """

    __tablename__ = "clustering_runs"
    __table_args__ = (Index("ix_clustering_runs_emb", "embedding_run_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    embedding_run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("embedding_runs.id", ondelete="CASCADE")
    )
    #: "original" | "projection"
    space: Mapped[str] = mapped_column(String(16), default="original")
    projection_run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("projection_runs.id", ondelete="CASCADE"), nullable=True
    )
    algorithm: Mapped[str] = mapped_column(String(32), default="dbscan")
    metric: Mapped[str] = mapped_column(String(32), default="cosine")
    params_json: Mapped[str] = mapped_column(String(2048))
    npz_relpath: Mapped[str] = mapped_column(String(512))
    count: Mapped[int] = mapped_column(Integer, default=0)
    n_clusters: Mapped[int] = mapped_column(Integer, default=0)
    noise: Mapped[int] = mapped_column(Integer, default=0)
    source_signature: Mapped[str] = mapped_column(String(64))
    #: embedding signature the PROJECTION coordinates were built from (only
    #: for space="projection"): labels describe that projection, so the run
    #: is stale when current vectors differ from it too (schema v7)
    projection_signature: Mapped[str | None] = mapped_column(String(64), nullable=True)
    versions_json: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40))


class FragmentGroupRow(Base):
    """A named manual group of fragments.

    Groups survive automatic clustering (independent entities) and store
    fragment IDs — not screen coordinates. Members cascade with fragments:
    a fragment deleted by reindex silently leaves the group (count shrinks;
    honest, no ghosts).
    """

    __tablename__ = "fragment_groups"
    __table_args__ = (UniqueConstraint("name", name="uq_fragment_group_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[str] = mapped_column(String(40))


class FragmentGroupMemberRow(Base):
    __tablename__ = "fragment_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "fragment_id", name="uq_group_member"),
        Index("ix_group_members_fragment", "fragment_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("fragment_groups.id", ondelete="CASCADE")
    )
    fragment_id: Mapped[str] = mapped_column(
        String(16), ForeignKey("fragments.id", ondelete="CASCADE")
    )


class SavedSliceRow(Base):
    """A saved mathematical slice of the ORIGINAL space.

    The normal is stored RESOLVED (exact D-dim unit vector at save time) so
    the slice stays reproducible even if a later PCA refit flips signs;
    `normal_kind`/`normal_index` keep the human-readable intent.
    """

    __tablename__ = "saved_slices"
    __table_args__ = (Index("ix_saved_slices_emb", "embedding_run_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    embedding_run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("embedding_runs.id", ondelete="CASCADE")
    )
    #: "axis" | "pca" | "vector" — how the normal was specified
    normal_kind: Mapped[str] = mapped_column(String(16), default="axis")
    normal_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: resolved unit normal (JSON list of floats, D entries)
    normal_json: Mapped[str] = mapped_column(String(262144))
    dim: Mapped[int] = mapped_column(Integer, default=0)
    #: signed offset of the plane point from the run centroid along n
    position: Mapped[float] = mapped_column(default=0.0)
    thickness: Mapped[float] = mapped_column(default=0.0)
    #: ABSOLUTE plane coordinate at save time: dot(centroid_at_save, n) +
    #: position. The centroid is data-dependent, so `position` alone does
    #: NOT reproduce the plane after the corpus changes; this offset does
    #: (schema v7; NULL for slices saved before v7 — treated as relative)
    plane_offset: Mapped[float | None] = mapped_column(nullable=True)
    created_at: Mapped[str] = mapped_column(String(40))


class MetricRunRow(Base):
    """One metric run: quality numbers of a projection and/or the
    agreement of original-space neighbors with KNOWN structural relations.

    Identity = fingerprint(embedding_run, projection_run, k, sample, seed,
    relation filter); results live in `result_json` (values + per-metric
    explanations + counts). `source_signature` marks the run stale when the
    vectors change — outdated numbers must never be shown as fresh.
    """

    __tablename__ = "metric_runs"
    __table_args__ = (Index("ix_metric_runs_emb", "embedding_run_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    embedding_run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("embedding_runs.id", ondelete="CASCADE")
    )
    projection_run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("projection_runs.id", ondelete="CASCADE"), nullable=True
    )
    k: Mapped[int] = mapped_column(Integer, default=10)
    sample_size: Mapped[int] = mapped_column(Integer, default=500)
    seed: Mapped[int] = mapped_column(Integer, default=42)
    params_json: Mapped[str] = mapped_column(String(4096))
    result_json: Mapped[str] = mapped_column(String(262144))
    n_vectors: Mapped[int] = mapped_column(Integer, default=0)
    source_signature: Mapped[str] = mapped_column(String(64))
    #: embedding signature the PROJECTION coordinates were built from (when a
    #: projection run was given): the metrics describe that projection, so the
    #: run is stale when current vectors differ from it too (schema v7)
    projection_signature: Mapped[str | None] = mapped_column(String(64), nullable=True)
    versions_json: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[str] = mapped_column(String(40))
    updated_at: Mapped[str] = mapped_column(String(40))


class ExperimentRow(Base):
    """A saved, reopenable experiment.

    `config_json` references the concrete runs (embeddings/projections/
    slice/clustering/groups/selection/metrics) captured from the UI;
    `snapshot_json` records the interpretation context AT SAVE TIME: corpus
    counts, embedding signature, app/schema versions, staleness of every
    reference and the metric values. Opening an experiment reports missing
    or stale references honestly instead of silently showing something else.
    """

    __tablename__ = "experiments"
    __table_args__ = (UniqueConstraint("name", name="uq_experiment_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    config_json: Mapped[str] = mapped_column(String(524288))
    snapshot_json: Mapped[str] = mapped_column(String(524288))
    created_at: Mapped[str] = mapped_column(String(40))
