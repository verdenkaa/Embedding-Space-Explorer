"""Schema migration tests: v6 → v7 column-level upgrades (additive, safe).

The v6 DDL below mirrors what SQLAlchemy created for schema v6 — tables
WITHOUT the columns v7 adds. `create_all` never touches existing tables, so
the upgrade path must ALTER them; fresh databases get complete tables from
`create_all` and the guarded ALTERs skip.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.storage.db import CURRENT_DB_SCHEMA, open_database
from app.storage.models import EmbeddingRunRow, JobRow
from sqlalchemy import text

_V6_JOBS_DDL = """
CREATE TABLE jobs (
    id VARCHAR(32) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    state VARCHAR(16) NOT NULL,
    progress_done INTEGER NOT NULL,
    progress_total INTEGER NOT NULL,
    message VARCHAR(2048),
    error VARCHAR(4096),
    warnings_json VARCHAR(65536),
    params_json VARCHAR(65536),
    created_at VARCHAR(40) NOT NULL,
    started_at VARCHAR(40),
    finished_at VARCHAR(40),
    PRIMARY KEY (id)
)
"""

_V6_EMBEDDING_RUNS_DDL = """
CREATE TABLE embedding_runs (
    id VARCHAR(32) NOT NULL,
    model_id VARCHAR(256) NOT NULL,
    dim INTEGER NOT NULL,
    mode VARCHAR(32) NOT NULL,
    template VARCHAR(2048) NOT NULL,
    params_json VARCHAR(2048) NOT NULL,
    npz_relpath VARCHAR(512) NOT NULL,
    count INTEGER NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id)
)
"""


def _make_v6_database(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "CREATE TABLE meta (key VARCHAR(64) NOT NULL PRIMARY KEY, value VARCHAR(256) NOT NULL)"
        )
        conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '6')")
        conn.execute(_V6_JOBS_DDL)
        conn.execute(_V6_EMBEDDING_RUNS_DDL)
        conn.execute(
            "INSERT INTO jobs (id, kind, state, progress_done, progress_total, created_at) "
            "VALUES ('j1', 'index', 'done', 3, 3, '2026-01-01T00:00:00+00:00')"
        )
        conn.execute(
            "INSERT INTO embedding_runs (id, model_id, dim, mode, template, params_json, "
            "npz_relpath, count, created_at, updated_at) VALUES "
            "('e1', 'm', 8, 'raw_fragment', '{}', '{}', 'cache/embeddings/e1.npz', 0, "
            "'2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')"
        )
        conn.commit()
    finally:
        conn.close()


def _columns(engine: object, table: str) -> set[str]:
    from sqlalchemy import Engine

    assert isinstance(engine, Engine)
    with engine.connect() as conn:
        return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}


def test_upgrade_from_v6_adds_columns_and_keeps_data(tmp_path: Path) -> None:
    db_path = tmp_path / "project.db"
    _make_v6_database(db_path)

    engine, session_factory = open_database(db_path)

    # a backup of the pre-migration database exists
    assert any(p.name.startswith("project.db.bak-") for p in tmp_path.iterdir())

    with engine.connect() as conn:
        version = conn.execute(
            text("SELECT value FROM meta WHERE key='schema_version'")
        ).scalar_one()
    assert int(version) == CURRENT_DB_SCHEMA == 7

    # the EXISTING v6 tables gained the new columns (ALTER path, not create_all)
    assert "result_json" in _columns(engine, "jobs")
    assert "truncated_count" in _columns(engine, "embedding_runs")
    # tables that did not exist in the v6 fixture were created complete
    assert "plane_offset" in _columns(engine, "saved_slices")
    assert "projection_signature" in _columns(engine, "metric_runs")
    assert "projection_signature" in _columns(engine, "clustering_runs")

    # old rows survived; new columns read back with honest defaults
    with session_factory() as session:
        job = session.get(JobRow, "j1")
        assert job is not None
        assert job.state == "done"
        assert job.result_json is None
        run = session.get(EmbeddingRunRow, "e1")
        assert run is not None
        assert run.model_id == "m"
        assert run.truncated_count == 0

    engine.dispose()


def test_upgrade_is_idempotent(tmp_path: Path) -> None:
    db_path = tmp_path / "project.db"
    _make_v6_database(db_path)

    engine, _ = open_database(db_path)
    engine.dispose()
    # second open: version is current, no ALTERs needed, no failure
    engine, _ = open_database(db_path)
    assert "result_json" in _columns(engine, "jobs")
    engine.dispose()


def test_fresh_database_has_v7_columns(tmp_path: Path) -> None:
    db_path = tmp_path / "fresh.db"
    engine, _ = open_database(db_path)
    with engine.connect() as conn:
        version = conn.execute(
            text("SELECT value FROM meta WHERE key='schema_version'")
        ).scalar_one()
    assert int(version) == 7
    assert "result_json" in _columns(engine, "jobs")
    assert "truncated_count" in _columns(engine, "embedding_runs")
    engine.dispose()
