"""Database engine/session management with schema versioning (TZ §9.4).

Rules:
- one SQLite database per project: <data_dir>/projects/<id>/project.db;
- WAL journal for concurrent reads while the indexer writes;
- `meta.schema_version` is checked on open: newer than supported → clear
  error (project not broken globally); older → backup file, then migrate
  (stage 1 introduces db schema v1; destructive fallback keeps a .bak copy).
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

CURRENT_DB_SCHEMA = 2


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
    with engine.begin() as conn:
        conn.execute(text("PRAGMA journal_mode=WAL"))
        conn.execute(text("PRAGMA foreign_keys=ON"))
        conn.execute(text("PRAGMA synchronous=NORMAL"))
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
        # Backup before migrating (TZ §9.4), then apply ADDITIVE migrations:
        # create_all only creates missing tables and never drops data.
        backup = db_path.with_suffix(f".db.bak-{int(time.time())}")
        shutil.copy2(db_path, backup)
        from app.storage import models

        Base.metadata.create_all(engine)
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
