"""Background jobs: id, state, progress, cancellation.

Single worker thread is enough for a local single-user tool; long operations
never run inside HTTP requests. Frontend polls GET /api/jobs/{id}.
"""

from __future__ import annotations

import json
import queue
import threading
import traceback
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from app.core.logging import get_logger
from app.storage.models import JobRow
from app.storage.projects_store import ProjectContext, ProjectStore

log = get_logger("jobs")


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class JobCancelledError(RuntimeError):
    """Raised inside a runner when cancellation was requested."""


@dataclass
class JobContext:
    """Handle passed to job runners for progress/cancel/warnings."""

    job_id: str
    project: ProjectContext
    _cancel_event: threading.Event
    warnings: list[str] = field(default_factory=list)
    #: structured result set by the runner via `set_result` (persisted as
    #: jobs.result_json when the job finishes; JSON-serializable dicts only)
    result: dict[str, Any] | None = None
    _last_progress_write: float = 0.0

    def cancelled(self) -> bool:
        return self._cancel_event.is_set()

    def check_cancelled(self) -> None:
        if self._cancel_event.is_set():
            raise JobCancelledError(self.job_id)

    def set_result(self, value: dict[str, Any]) -> None:
        """Attach a structured result (e.g. ids of the runs the job created).

        Clients must never have to GUESS which artifacts a job produced from
        the human-readable message — they reference them by id.
        """
        self.result = value

    def progress(
        self, done: int, total: int, message: str | None = None, force: bool = False
    ) -> None:
        """Persist progress (throttled to ~4 writes/second unless forced)."""
        now = datetime.now(UTC).timestamp()
        if not force and now - self._last_progress_write < 0.25:
            return
        self._last_progress_write = now
        with self.project.session_factory() as session:
            job = session.get(JobRow, self.job_id)
            if job is not None:
                job.progress_done = done
                job.progress_total = total
                if message is not None:
                    job.message = message
                session.commit()

    def warn(self, message: str) -> None:
        if len(self.warnings) < 500:
            self.warnings.append(message)


JobRunner = Callable[[JobContext], str | None]


@dataclass
class _Task:
    job_id: str
    project_id: str
    runner: JobRunner
    cancel_event: threading.Event


class JobManager:
    """Queue + single daemon worker owning all background jobs."""

    def __init__(self, project_store: ProjectStore) -> None:
        self._store = project_store
        self._queue: queue.Queue[_Task | None] = queue.Queue()
        self._cancel_events: dict[str, threading.Event] = {}
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._run_loop, name="ese-jobs", daemon=True)
        self._worker.start()

    # -- public API ------------------------------------------------------------

    def submit(
        self,
        project: ProjectContext,
        kind: str,
        runner: JobRunner,
        params: dict[str, Any] | None = None,
    ) -> str:
        job_id = uuid.uuid4().hex[:16]
        cancel_event = threading.Event()
        with project.session_factory() as session:
            session.add(
                JobRow(
                    id=job_id,
                    kind=kind,
                    state="queued",
                    params_json=json.dumps(params or {}),
                    created_at=_utc_now(),
                )
            )
            session.commit()
        with self._lock:
            self._cancel_events[job_id] = cancel_event
        self._queue.put(_Task(job_id, project.id, runner, cancel_event))
        return job_id

    def cancel(self, project: ProjectContext, job_id: str) -> bool:
        with project.session_factory() as session:
            job = session.get(JobRow, job_id)
            if job is None:
                return False
            if job.state in ("done", "failed", "cancelled"):
                return False
            was_queued = job.state == "queued"
            if was_queued:
                job.state = "cancelled"
                job.finished_at = _utc_now()
                job.message = "cancelled before start"
                session.commit()
        # Always signal the event so the worker skips the job even if it was
        # picked up between the DB update and now.
        with self._lock:
            event = self._cancel_events.get(job_id)
        if event is not None:
            event.set()
        return True

    def shutdown(self) -> None:
        self._queue.put(None)
        self._worker.join(timeout=5)

    # -- worker ------------------------------------------------------------------

    def _run_loop(self) -> None:
        while True:
            task = self._queue.get()
            if task is None:
                return
            self._execute(task)

    def _execute(self, task: _Task) -> None:
        try:
            project = self._store.open(task.project_id)
        except Exception:  # pragma: no cover - project deleted mid-flight
            log.exception("job %s: cannot open project %s", task.job_id, task.project_id)
            return

        if task.cancel_event.is_set():
            self._finish(task, project, "cancelled", message="cancelled before start")
            return

        with project.session_factory() as session:
            job = session.get(JobRow, task.job_id)
            if job is not None:
                job.state = "running"
                job.started_at = _utc_now()
                session.commit()

        ctx = JobContext(job_id=task.job_id, project=project, _cancel_event=task.cancel_event)
        try:
            message = task.runner(ctx)
            self._finish(
                task, project, "done", message=message, warnings=ctx.warnings, result=ctx.result
            )
        except JobCancelledError:
            self._finish(
                task,
                project,
                "cancelled",
                message="cancelled by user",
                warnings=ctx.warnings,
                result=ctx.result,
            )
        except Exception as exc:
            # Log with traceback server-side; expose only a short repr to the
            # API — logs must not leak source content.
            log.error("job %s failed: %r\n%s", task.job_id, exc, traceback.format_exc())
            self._finish(
                task,
                project,
                "failed",
                error=f"{exc.__class__.__name__}: {exc}"[:4000],
                warnings=ctx.warnings,
            )
        finally:
            with self._lock:
                self._cancel_events.pop(task.job_id, None)

    def _finish(
        self,
        task: _Task,
        project: ProjectContext,
        state: str,
        message: str | None = None,
        error: str | None = None,
        warnings: list[str] | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        with project.session_factory() as session:
            job = session.get(JobRow, task.job_id)
            if job is None:
                return
            job.state = state
            job.finished_at = _utc_now()
            if message is not None:
                job.message = message
            if error is not None:
                job.error = error
            if warnings:
                job.warnings_json = json.dumps(warnings[:500], ensure_ascii=False)
            if result is not None:
                job.result_json = json.dumps(result, ensure_ascii=False, default=str)[:65536]
            session.commit()
