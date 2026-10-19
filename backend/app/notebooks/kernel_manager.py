"""Kernel sessions: one long-lived ipykernel per open notebook.

Lifecycle rules (TZ §5.4):

* a kernel is NOT started per cell — one session per (project, notebook)
  keeps Python state between cells; different notebooks never share state;
* sessions are started/stopped explicitly and reaped after an idle TTL, so
  abandoned kernels do not accumulate; application shutdown closes them all;
* a session is bound to its project AND its resolved notebook path: an
  execute request for notebook A can never land in the kernel of notebook B
  just because filenames match (the frontend polls by session_id, the
  manager verifies the project on every access);
* the kernel's working directory is the project workspace (stable for the
  session, independent of where the backend process was launched from);
* output is capped: a runaway print loop cannot exhaust memory.
"""

from __future__ import annotations

import contextlib
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Empty
from typing import Any

from jupyter_client.manager import KernelManager

from app.core.logging import get_logger

log = get_logger("kernels")

#: Hard cap on the number of simultaneous kernel sessions (memory honesty).
MAX_SESSIONS = int(os.environ.get("ESE_KERNEL_SESSION_LIMIT", "4"))

#: Idle sessions are shut down after this many seconds (default 30 min).
IDLE_TTL_SECONDS = float(os.environ.get("ESE_KERNEL_IDLE_TTL", "1800"))

#: Total output cap per execution (~2 MB of JSON text) + per-field cap.
MAX_EXECUTION_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_FIELD_CHARS = 200_000

#: How many finished executions a session remembers for polling.
EXECUTION_HISTORY = 32

KERNEL_READY_TIMEOUT = 60.0


@dataclass
class Execution:
    """One cell execution: status + accumulated nbformat-style outputs."""

    id: str
    code: str
    status: str = "running"  # running | done | error | interrupted | aborted
    outputs: list[dict[str, Any]] = field(default_factory=list)
    execution_count: int | None = None
    error: str | None = None
    truncated: bool = False
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    _output_bytes: int = field(default=0, repr=False)

    def add_output(self, output: dict[str, Any]) -> None:
        """Append an output, enforcing the total and per-field caps."""
        if self.truncated:
            return
        for key in ("text", "traceback"):
            value = output.get(key)
            if isinstance(value, str) and len(value) > MAX_FIELD_CHARS:
                output[key] = value[:MAX_FIELD_CHARS] + "\n… [обрезано]"
            elif isinstance(value, list):
                joined = sum(len(str(v)) for v in value)
                if joined > MAX_FIELD_CHARS:
                    truncated = [str(v) for v in value][:50]
                    truncated.append("… [обрезано]")
                    output[key] = truncated
        size = len(str(output))
        if self._output_bytes + size > MAX_EXECUTION_OUTPUT_BYTES:
            self.truncated = True
            self.outputs.append(
                {
                    "output_type": "stream",
                    "name": "stderr",
                    "text": "[вывод превысил лимит и обрезан — уменьшите объём печати]",
                }
            )
            return
        self._output_bytes += size
        self.outputs.append(output)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "outputs": self.outputs,
            "execution_count": self.execution_count,
            "error": self.error,
            "truncated": self.truncated,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


class KernelSession:
    """A notebook's execution context: kernel + client + execution queue."""

    def __init__(
        self,
        session_id: str,
        project_id: str,
        notebook_path: Path,
        workspace_dir: Path,
    ) -> None:
        self.session_id = session_id
        self.project_id = project_id
        self.notebook_path = notebook_path
        self.workspace_dir = workspace_dir
        #: relative path of the notebook inside the workspace (for the UI)
        self.notebook_rel = notebook_path.relative_to(workspace_dir).as_posix()
        self.state = "starting"  # starting | ready | restarting | dead | error
        self.error: str | None = None
        self.started_at = time.time()
        self.last_used = time.time()
        self.lock = threading.Lock()
        self.current: Execution | None = None
        self.history: dict[str, Execution] = {}
        self.history_order: list[str] = []
        self._km: Any = None
        self._client: Any = None
        self._interrupt_requested = False
        self._closed = False

    # -- public API -----------------------------------------------------------

    def touch(self) -> None:
        self.last_used = time.time()

    def describe(self) -> dict[str, Any]:
        with self.lock:
            self._refresh_liveness_locked()
            return {
                "session_id": self.session_id,
                "project_id": self.project_id,
                "path": self.notebook_rel,
                "state": self.state,
                "error": self.error,
                "busy": self.current is not None and self.current.status == "running",
                "started_at": self.started_at,
                "last_used": self.last_used,
            }

    def get_execution(self, execution_id: str) -> Execution | None:
        with self.lock:
            execution = self.history.get(execution_id)
            if execution is not None:
                self.last_used = time.time()
            return execution

    # -- internals ------------------------------------------------------------

    def _refresh_liveness_locked(self) -> None:
        """Mark the session dead when the kernel process disappeared."""
        if self._closed or self.state not in ("ready", "restarting"):
            return
        km = self._km
        try:
            alive = bool(km is not None and km.is_alive())
        except Exception:
            alive = False
        if not alive and self.state == "ready":
            self.state = "dead"
            self.error = "ядро Python неожиданно завершилось — перезапустите его"
            if self.current is not None and self.current.status == "running":
                self.current.status = "error"
                self.current.error = "kernel died during execution"
                self.current.finished_at = time.time()

    def start(self, data_dir: Path, backend_root: Path) -> None:
        """Launch the kernel (called in a worker thread by the manager)."""
        try:
            env = os.environ.copy()
            existing = env.get("PYTHONPATH", "")
            env["PYTHONPATH"] = (
                f"{backend_root}{os.pathsep}{existing}" if existing else str(backend_root)
            )
            env["ESE_PROJECT_ID"] = self.project_id
            env["ESE_DATA_DIR"] = str(data_dir)
            env["ESE_WORKSPACE_DIR"] = str(self.workspace_dir)
            env["ESE_SESSION_ID"] = self.session_id
            env["PYTHONUNBUFFERED"] = "1"
            km = KernelManager()
            km.start_kernel(cwd=str(self.workspace_dir), env=env)
            client = km.client()
            client.start_channels()
            client.wait_for_ready(timeout=KERNEL_READY_TIMEOUT)
            with self.lock:
                self._km = km
                self._client = client
                if self._closed:  # shutdown raced with startup
                    self._cleanup_locked()
                    return
                self.state = "ready"
                self.error = None
            log.info("kernel started: session=%s project=%s", self.session_id, self.project_id)
        except Exception as exc:
            with self.lock:
                self.state = "error"
                self.error = f"{exc.__class__.__name__}: {exc}"
            log.warning("kernel start failed: %s", self.error)

    def execute(self, code: str) -> Execution:
        """Queue a cell execution on a background thread. Ready sessions only."""
        with self.lock:
            self._refresh_liveness_locked()
            if self.state != "ready":
                raise KernelNotReadyError(self.state, self.error)
            if self.current is not None and self.current.status == "running":
                raise ExecutionInProgressError(self.current.id)
            execution = Execution(id=uuid.uuid4().hex[:12], code=code)
            self.current = execution
            self.history[execution.id] = execution
            self.history_order.append(execution.id)
            while len(self.history_order) > EXECUTION_HISTORY:
                self.history.pop(self.history_order.pop(0), None)
            self._interrupt_requested = False
            self.last_used = time.time()
        thread = threading.Thread(
            target=self._run_execution, args=(execution,), daemon=True, name="ese-exec"
        )
        thread.start()
        return execution

    def _run_execution(self, execution: Execution) -> None:
        client = self._client
        interrupted = False
        try:
            msg_id = client.execute(execution.code, allow_stdin=False)
            while True:
                try:
                    message = client.get_iopub_msg(timeout=0.25)
                except Empty:
                    with self.lock:
                        if self._closed:
                            execution.status = "aborted"
                            execution.finished_at = time.time()
                            return
                    km = self._km
                    try:
                        alive = km is None or bool(km.is_alive())
                    except Exception:
                        alive = False
                    if not alive:
                        execution.status = "error"
                        execution.error = "kernel died during execution"
                        break
                    continue
                parent = message.get("parent_header", {}).get("msg_id")
                if parent != msg_id:
                    continue
                kind = message["msg_type"]
                content = message["content"]
                if kind == "stream":
                    execution.add_output(
                        {
                            "output_type": "stream",
                            "name": content.get("name", "stdout"),
                            "text": content.get("text", ""),
                        }
                    )
                elif kind in ("execute_result", "display_data"):
                    output: dict[str, Any] = {
                        "output_type": kind,
                        "data": content.get("data", {}),
                        "metadata": content.get("metadata", {}),
                    }
                    if kind == "execute_result":
                        output["execution_count"] = content.get("execution_count")
                        execution.execution_count = content.get("execution_count")
                    execution.add_output(output)
                elif kind == "update_display_data":
                    execution.add_output(
                        {
                            "output_type": "display_data",
                            "data": content.get("data", {}),
                            "metadata": content.get("metadata", {}),
                        }
                    )
                elif kind == "error":
                    if content.get("ename") == "KeyboardInterrupt":
                        interrupted = True
                    execution.add_output(
                        {
                            "output_type": "error",
                            "ename": content.get("ename", "Error"),
                            "evalue": content.get("evalue", ""),
                            "traceback": content.get("traceback", []),
                        }
                    )
                    execution.error = f"{content.get('ename')}: {content.get('evalue')}"
                elif kind == "execute_input":
                    execution.execution_count = content.get("execution_count")
                elif kind == "status" and content.get("execution_state") == "idle":
                    break
            if execution.status == "running":
                execution.status = "interrupted" if interrupted else "done"
        except Exception as exc:
            execution.status = "error"
            execution.error = f"{exc.__class__.__name__}: {exc}"
        finally:
            execution.finished_at = time.time()

    def interrupt(self) -> None:
        with self.lock:
            self._interrupt_requested = True
            km = self._km
        if km is not None:
            try:
                km.interrupt_kernel()
            except Exception as exc:
                log.warning("interrupt failed: %s", exc)

    def restart(self) -> None:
        """Restart the kernel in a worker thread; state goes restarting→ready."""
        with self.lock:
            if self.state in ("dead", "error", "restarting"):
                pass  # restart is exactly the recovery action for dead/error
            current = self.current
            if current is not None and current.status == "running":
                current.status = "aborted"
                current.error = "kernel restarted during execution"
                current.finished_at = time.time()
            self.state = "restarting"
            self.error = None
            km = self._km
        thread = threading.Thread(
            target=self._run_restart, args=(km,), daemon=True, name="ese-restart"
        )
        thread.start()

    def _run_restart(self, km: Any) -> None:
        try:
            if km is None:
                raise RuntimeError("kernel process is gone")
            km.restart_kernel(now=True)
            client = self._client
            client.wait_for_ready(timeout=KERNEL_READY_TIMEOUT)
            with self.lock:
                self.state = "ready"
                self.error = None
                self.last_used = time.time()
            log.info("kernel restarted: session=%s", self.session_id)
        except Exception as exc:
            with self.lock:
                self.state = "error"
                self.error = f"перезапуск не удался: {exc.__class__.__name__}: {exc}"

    def shutdown(self) -> None:
        with self.lock:
            self._closed = True
            current = self.current
            if current is not None and current.status == "running":
                current.status = "aborted"
                current.error = "session closed"
                current.finished_at = time.time()
            self._cleanup_locked()
        log.info("kernel stopped: session=%s", self.session_id)

    def _cleanup_locked(self) -> None:
        client, km = self._client, self._km
        self._client = None
        self._km = None
        if client is not None:
            with contextlib.suppress(Exception):
                client.stop_channels()
        if km is not None:
            with contextlib.suppress(Exception):
                km.shutdown_kernel(now=True)
        if self.state not in ("error",):
            self.state = "dead"


class KernelNotReadyError(RuntimeError):
    def __init__(self, state: str, error: str | None) -> None:
        super().__init__(f"kernel is {state}" + (f": {error}" if error else ""))
        self.state = state
        self.error = error


class ExecutionInProgressError(RuntimeError):
    def __init__(self, execution_id: str) -> None:
        super().__init__(f"execution {execution_id} is still running")
        self.execution_id = execution_id


class KernelLimitError(RuntimeError):
    pass


class KernelSessionManager:
    """All sessions of the application; owned by app.state (lifespan)."""

    def __init__(self) -> None:
        self._sessions: dict[str, KernelSession] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True, name="ese-reaper")
        self._reaper.start()

    # -- session lifecycle -----------------------------------------------------

    def start_session(
        self,
        project_id: str,
        workspace_dir: Path,
        notebook_path: Path,
        data_dir: Path,
        backend_root: Path,
    ) -> KernelSession:
        """Start (or return the existing) session for a notebook.

        The binding is (project_id, resolved notebook path): the same filename
        in another project is another session (TZ §5.6).
        """
        with self._lock:
            existing = self._find_locked(project_id, notebook_path)
            if existing is not None and existing.state not in ("dead", "error"):
                existing.touch()
                return existing
            if existing is not None:
                # A dead/errored session is replaced by a fresh kernel.
                self._sessions.pop(existing.session_id, None)
                existing.shutdown()
            alive = len(self._sessions)
            if alive >= MAX_SESSIONS:
                raise KernelLimitError(
                    f"достигнут предел одновременных ядер ({MAX_SESSIONS}); "
                    "закройте лишнюю сессию блокнота"
                )
            session = KernelSession(
                session_id=uuid.uuid4().hex[:12],
                project_id=project_id,
                notebook_path=notebook_path,
                workspace_dir=workspace_dir,
            )
            self._sessions[session.session_id] = session
        threading.Thread(
            target=session.start,
            args=(data_dir, backend_root),
            daemon=True,
            name=f"ese-kernel-{session.session_id}",
        ).start()
        return session

    def _find_locked(self, project_id: str, notebook_path: Path) -> KernelSession | None:
        for session in self._sessions.values():
            if session.project_id == project_id and session.notebook_path == notebook_path:
                return session
        return None

    def get(self, session_id: str, project_id: str) -> KernelSession | None:
        """Lookup with a project check: other projects' sessions are invisible."""
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or session.project_id != project_id:
                return None
            session.touch()
            return session

    def list_for_project(self, project_id: str) -> list[dict[str, Any]]:
        with self._lock:
            sessions = [s for s in self._sessions.values() if s.project_id == project_id]
        return [s.describe() for s in sessions]

    def find(self, project_id: str, notebook_rel: str, workspace_dir: Path) -> KernelSession | None:
        path = (workspace_dir / notebook_rel).resolve()
        with self._lock:
            return self._find_locked(project_id, path)

    def close_session(self, session_id: str, project_id: str) -> bool:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None or session.project_id != project_id:
                return False
            self._sessions.pop(session_id, None)
        session.shutdown()
        return True

    def shutdown_all(self) -> None:
        self._stop.set()
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.shutdown()
        log.info("all kernel sessions closed (%d)", len(sessions))

    # -- idle reaping -----------------------------------------------------------

    def _reap_loop(self) -> None:
        while not self._stop.wait(30.0):
            now = time.time()
            with self._lock:
                expired = [
                    s
                    for s in self._sessions.values()
                    if now - s.last_used > IDLE_TTL_SECONDS
                    and not (s.current is not None and s.current.status == "running")
                ]
                for session in expired:
                    self._sessions.pop(session.session_id, None)
            for session in expired:
                log.info("reaping idle kernel session=%s", session.session_id)
                session.shutdown()


__all__ = [
    "MAX_SESSIONS",
    "Execution",
    "ExecutionInProgressError",
    "KernelLimitError",
    "KernelNotReadyError",
    "KernelSession",
    "KernelSessionManager",
]
