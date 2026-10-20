"""Database engine/session management with schema versioning.

Rules:
- one SQLite database per project: <data_dir>/projects/<id>/project.db;
- WAL journal for concurrent reads while the indexer writes;
- `meta.schema_version` is checked on open: newer than supported → clear
  error (project not broken globally); older → backup file, then migrate
  (migrations are additive: v1 corpus, v2 embedding_runs, v3 projection_runs,
    v4 projection_presets, v5 relations/clustering/groups/slices,
    v6 metric_runs/experiments,
    v7 column-level additions: jobs.result_json, embedding_runs.truncated_count,
       saved_slices.plane_offset, metric_runs/clustering_runs.projection_signature;
    the pre-migration .bak copy guards against surprises).

`Base.metadata.create_all` only creates MISSING TABLES — it never adds
columns to tables that already exist. Since v7 the upgrade path also runs
idempotent `ALTER TABLE ... ADD COLUMN` statements (guarded by
`PRAGMA table_info`), so old projects gain new columns without losing data.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

CURRENT_DB_SCHEMA = 7

#: (table, column, column DDL) added in schema v7. Applied AFTER create_all,
#: each guarded by existence checks — safe to re-run and safe on fresh
#: databases (create_all already made the tables WITH these columns).
_V7_ADDED_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("jobs", "result_json", "VARCHAR(65536)"),
    ("embedding_runs", "truncated_count", "INTEGER NOT NULL DEFAULT 0"),
    ("saved_slices", "plane_offset", "FLOAT"),
    ("metric_runs", "projection_signature", "VARCHAR(64)"),
    ("clustering_runs", "projection_signature", "VARCHAR(64)"),
)


class Base(DeclarativeBase):
    pass


class ProjectSchemaError(RuntimeError):
    """Raised when a project database cannot be used by this app version."""


def _make_engine(db_path: Path) -> Engine:
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        future=True,
    )

    # foreign_keys/synchronous are PER-CONNECTION in SQLite: applying them
    # once at engine creation would leave later pooled connections without
    # FK enforcement (cascades silently stop working). The connect event
    # configures every connection the pool creates.
    @event.listens_for(engine, "connect")
    def _configure_connection(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA synchronous=NORMAL")
        finally:
            cursor.close()

    return engine


def _read_schema_version(engine: Engine) -> int | None:
    with engine.connect() as conn:
        exists = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
        ).first()
        if not exists:
            return None
        row = conn.execute(text("SELECT value FROM meta WHERE key='schema_version'")).first()
    return int(row[0]) if row else None


def _migrate_added_columns(engine: Engine) -> list[str]:
    """Idempotent column-level migration (v7+): ADD COLUMN where missing.

    Returns the list of "table.column" actually added (for logging/tests).
    Tables that do not exist are skipped — create_all makes them complete.
    """
    added: list[str] = []
    with engine.begin() as conn:
        for table, column, ddl in _V7_ADDED_COLUMNS:
            table_exists = conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name=:t"),
                {"t": table},
            ).first()
            if table_exists is None:
                continue
            cols = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            if column in cols:
                continue
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
            added.append(f"{table}.{column}")
    return added


def open_database(db_path: Path) -> tuple[Engine, sessionmaker[Session]]:
    """Open (creating if needed) a project database; enforce schema version."""
    is_new = not db_path.exists()
    engine = _make_engine(db_path)

    version = None if is_new else _read_schema_version(engine)
    if version is not None and version > CURRENT_DB_SCHEMA:
        engine.dispose()
        raise ProjectSchemaError(
            f"project database schema v{version} is newer than supported "
            f"v{CURRENT_DB_SCHEMA}; update the application to open this project"
        )
    if version is not None and version < CURRENT_DB_SCHEMA:
        # Backup before migrating, then apply ADDITIVE migrations:
        # create_all only creates missing tables and never drops data;
        # _migrate_added_columns extends tables that already existed.
        backup = db_path.with_suffix(f".db.bak-{int(time.time())}")
        shutil.copy2(db_path, backup)
        from app.storage import models

        Base.metadata.create_all(engine)
        _migrate_added_columns(engine)
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE meta SET value = :v WHERE key = 'schema_version'"),
                {"v": str(CURRENT_DB_SCHEMA)},
            )
        version = CURRENT_DB_SCHEMA

    if version is None:
        from app.storage import models  # noqa: F401 - ensure mappers registered

        Base.metadata.create_all(engine)
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO meta (key, value) VALUES ('schema_version', :v)"),
                {"v": str(CURRENT_DB_SCHEMA)},
            )

    return engine, sessionmaker(bind=engine, expire_on_commit=False)
