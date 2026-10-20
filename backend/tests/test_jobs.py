"""Job manager tests: cancellation, failure capture, queued cancel."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from app.api.serialization import job_info_from_row
from app.jobs.manager import JobContext, JobManager
from app.storage.models import JobRow
from app.storage.projects_store import ProjectContext, ProjectStore


def _job_state(ctx: ProjectContext, job_id: str) -> str:
    with ctx.session_factory() as session:
        row = session.get(JobRow, job_id)
        assert row is not None
        return row.state


def _wait_state(ctx: ProjectContext, job_id: str, wanted: str, timeout: float = 5.0) -> str:
    deadline = time.monotonic() + timeout
    state = ""
    while time.monotonic() < deadline:
        state = _job_state(ctx, job_id)
        if state == wanted:
            return state
        time.sleep(0.02)
    return state


def test_running_job_cancellation(tmp_path: Path, sample_project: Path) -> None:
    store = ProjectStore(tmp_path / "data")
    ctx = store.create_project("p", [str(sample_project)])
    manager = JobManager(store)
    try:
        started = threading.Event()

        def runner(job: JobContext) -> str:
            started.set()
            while True:
                job.check_cancelled()
                time.sleep(0.01)

        job_id = manager.submit(ctx, "test", runner)
        assert started.wait(5), "runner did not start"
        assert manager.cancel(ctx, job_id) is True
        assert _wait_state(ctx, job_id, "cancelled") == "cancelled"
    finally:
        manager.shutdown()
        store.close_all()


def test_failed_job_records_error(tmp_path: Path, sample_project: Path) -> None:
    store = ProjectStore(tmp_path / "data")
    ctx = store.create_project("p", [str(sample_project)])
    manager = JobManager(store)
    try:

        def runner(job: JobContext) -> str:
            del job
            raise ValueError("boom")

        job_id = manager.submit(ctx, "test", runner)
        assert _wait_state(ctx, job_id, "failed") == "failed"
        with ctx.session_factory() as session:
            row = session.get(JobRow, job_id)
            assert row is not None
            assert row.error is not None and "boom" in row.error
            # The error string must not embed source content, only the repr.
            assert len(row.error) < 500
    finally:
        manager.shutdown()
        store.close_all()


def test_queued_job_cancelled_before_start(tmp_path: Path, sample_project: Path) -> None:
    store = ProjectStore(tmp_path / "data")
    ctx = store.create_project("p", [str(sample_project)])
    manager = JobManager(store)
    try:
        release = threading.Event()
        started = threading.Event()

        def blocker(job: JobContext) -> str:
            del job
            started.set()
            release.wait(10)
            return "done"

        def trivial(job: JobContext) -> str:
            del job
            return "done"

        first = manager.submit(ctx, "blocker", blocker)
        assert started.wait(5)
        second = manager.submit(ctx, "trivial", trivial)
        # Second job is still queued behind the blocker.
        assert manager.cancel(ctx, second) is True
        assert _job_state(ctx, second) == "cancelled"
        release.set()
        assert _wait_state(ctx, first, "done") == "done"
        # Cancelled job must not run afterwards.
        time.sleep(0.2)
        assert _job_state(ctx, second) == "cancelled"
    finally:
        manager.shutdown()
        store.close_all()


def test_progress_is_persisted(tmp_path: Path, sample_project: Path) -> None:
    store = ProjectStore(tmp_path / "data")
    ctx = store.create_project("p", [str(sample_project)])
    manager = JobManager(store)
    try:
        done = threading.Event()

        def runner(job: JobContext) -> str:
            for i in range(5):
                job.progress(i, 5, f"step {i}", force=True)
            job.progress(5, 5, "finished", force=True)
            job.warn("sample warning")
            done.set()
            return "ok"

        job_id = manager.submit(ctx, "test", runner)
        assert done.wait(5)
        assert _wait_state(ctx, job_id, "done") == "done"
        with ctx.session_factory() as session:
            row = session.get(JobRow, job_id)
            assert row is not None
            assert (row.progress_done, row.progress_total) == (5, 5)
            # The runner's return value becomes the final job message.
            assert row.message == "ok"
            assert row.warnings_json is not None and "sample warning" in row.warnings_json
    finally:
        manager.shutdown()
        store.close_all()


def test_structured_result_is_persisted_and_serialized(
    tmp_path: Path, sample_project: Path
) -> None:
    """ctx.set_result lands in jobs.result_json and in the JobInfo DTO."""
    store = ProjectStore(tmp_path / "data")
    ctx = store.create_project("p", [str(sample_project)])
    manager = JobManager(store)
    try:

        def runner(job: JobContext) -> str:
            job.set_result({"projection_run_ids": ["abc123", "def456"]})
            return "built 2 projections"

        job_id = manager.submit(ctx, "test", runner)
        assert _wait_state(ctx, job_id, "done") == "done"
        with ctx.session_factory() as session:
            row = session.get(JobRow, job_id)
            assert row is not None
            assert row.result_json is not None
            assert json.loads(row.result_json) == {"projection_run_ids": ["abc123", "def456"]}
            info = job_info_from_row(row)
            assert info.result == {"projection_run_ids": ["abc123", "def456"]}
            assert info.message == "built 2 projections"
    finally:
        manager.shutdown()
        store.close_all()


def test_failed_job_has_no_result(tmp_path: Path, sample_project: Path) -> None:
    store = ProjectStore(tmp_path / "data")
    ctx = store.create_project("p", [str(sample_project)])
    manager = JobManager(store)
    try:

        def runner(job: JobContext) -> str:
            job.set_result({"partial": True})
            raise RuntimeError("boom")

        job_id = manager.submit(ctx, "test", runner)
        assert _wait_state(ctx, job_id, "failed") == "failed"
        with ctx.session_factory() as session:
            row = session.get(JobRow, job_id)
            assert row is not None
            assert row.result_json is None
    finally:
        manager.shutdown()
        store.close_all()
