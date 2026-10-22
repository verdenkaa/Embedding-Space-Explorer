"""Доступ к данным проекта ESE из Python (только чтение).

Модуль переиспользует доменные компоненты приложения (модели SQLite,
.npz-кэши векторов/проекций/кластеров, точный kNN), а не дублирует их:
единственный источник истины остаётся основным хранилищем проекта.

Точки входа:
    current()          — проект текущего ядра (ESE_PROJECT_ID из окружения)
    load(project_id)   — явное открытие другого проекта
    list_projects()    — список проектов в data dir
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

import numpy as np
from app import SCHEMA_VERSION
from app.config import default_data_dir
from app.jobs.clustering import load_labels
from app.neighbor_search.search import NeighborSearchError, knn
from app.projection_methods.cache import ProjectionCache
from app.storage.models import (
    ClusteringRunRow,
    EmbeddingRunRow,
    ExperimentRow,
    FileRow,
    FragmentGroupMemberRow,
    FragmentGroupRow,
    FragmentRow,
    MetricRunRow,
    ProjectionRunRow,
    RelationRow,
    SavedSliceRow,
)
from app.storage.projects_store import ProjectManifest, resolve_safe_under_roots
from app.vector_store.npz_cache import NpzEmbeddingCache
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


class ProjectError(RuntimeError):
    """Проект/пространство/артефакт недоступен — с понятным объяснением."""


def _env_data_dir() -> Path:
    raw = os.environ.get("ESE_DATA_DIR", "").strip()
    return Path(raw).expanduser() if raw else default_data_dir()


def data_dir() -> Path:
    """Корень данных приложения (ESE_DATA_DIR или ~/.embedding-space-explorer)."""
    return _env_data_dir()


def list_projects(data_directory: Path | None = None) -> list[dict[str, Any]]:
    """Все проекты в data dir: id, имя, корни, ошибка манифеста (если есть)."""
    root = (data_directory or _env_data_dir()) / "projects"
    result: list[dict[str, Any]] = []
    if not root.exists():
        return result
    for entry in sorted(root.iterdir()):
        manifest_path = entry / "project.json"
        if not entry.is_dir() or not manifest_path.exists():
            continue
        try:
            manifest = ProjectManifest.model_validate_json(manifest_path.read_text("utf-8"))
            result.append(
                {
                    "id": manifest.id,
                    "name": manifest.name,
                    "roots": manifest.roots,
                    "updated_at": manifest.updated_at,
                    "error": None,
                }
            )
        except Exception as exc:  # повреждённый манифест не ломает список
            result.append({"id": entry.name, "name": entry.name, "roots": [], "error": str(exc)})
    return result


def load(project_id: str, data_directory: Path | None = None) -> ProjectHandle:
    """Явно открыть проект по id (доступ к чужому проекту — осознанный)."""
    root = (data_directory or _env_data_dir()) / "projects" / project_id
    manifest_path = root / "project.json"
    if not manifest_path.exists():
        available = [p["id"] for p in list_projects(data_directory)]
        raise ProjectError(
            f"проект '{project_id}' не найден в {root.parent}; доступны: {available or '—'}"
        )
    try:
        manifest = ProjectManifest.model_validate_json(manifest_path.read_text("utf-8"))
    except Exception as exc:
        raise ProjectError(f"манифест проекта '{project_id}' повреждён: {exc}") from exc
    return ProjectHandle(manifest=manifest, data_directory=data_directory or _env_data_dir())


def current() -> ProjectHandle:
    """Проект, к которому привязано это ядро (ESE_PROJECT_ID)."""
    project_id = os.environ.get("ESE_PROJECT_ID", "").strip()
    if not project_id:
        raise ProjectError(
            "ESE_PROJECT_ID не задан: вне ядра Notebook используйте "
            "ese.project.load('<project-id>') или ese.project.list_projects()"
        )
    return load(project_id)


def quickstart() -> str:
    """Краткая справка по API (тот же текст, что в docstring пакета)."""
    import ese

    return ese.__doc__ or ""


# ---------------------------------------------------------------------------
# Handles
# ---------------------------------------------------------------------------


@dataclass
class SpaceHandle:
    """Одно векторное пространство (embedding run) проекта.

    Векторы НЕ загружаются в память до вызова embeddings()/ids — тяжёлые
    данные подтягиваются по запросу (ядро не грузит всё на старте).
    """

    project: ProjectHandle
    id: str
    model_id: str
    dim: int
    mode: str
    template: str
    count: int
    created_at: str
    updated_at: str
    _cache: NpzEmbeddingCache | None = field(default=None, repr=False)

    # -- vectors -------------------------------------------------------------

    def _npz(self) -> NpzEmbeddingCache:
        if self._cache is None:
            path = self.project.project_dir / self._npz_relpath()
            if not path.exists():
                raise ProjectError(
                    f"кэш векторов пространства '{self.id}' отсутствует ({path.name}); "
                    "пересчитайте эмбеддинги в разделе EXPERIMENTS"
                )
            self._cache = NpzEmbeddingCache.load(path)
        return self._cache

    def _npz_relpath(self) -> str:
        with self.project._session() as session:
            row = session.get(EmbeddingRunRow, self.id)
        if row is None:
            raise ProjectError(f"embedding run '{self.id}' не найден")
        return row.npz_relpath

    def __repr__(self) -> str:
        return (
            f"<Space {self.id[:8]} model={self.model_id!r} mode={self.mode} "
            f"dim={self.dim} count={self.count}>"
        )

    @property
    def ids(self) -> np.ndarray:
        """id фрагментов в порядке строк матрицы эмбеддингов."""
        return np.array(self._npz().ids, dtype=np.str_)

    def embeddings(self) -> np.ndarray:
        """Матрица векторов (N, D) float32 — грузится из .npz по запросу.

        Возвращается READ-ONLY представление массива в кэше сессии ядра
        (копия данных не создаётся): случайная in-place операция в ячейке
        (X -= X.mean(axis=0), нормализация и т.п.) больше не может испортить
        векторы для последующих вызовов neighbors()/signature() в этом же
        блокноте. Нужна изменяемая матрица — сделайте копию явно:
        X = sp.embeddings().copy()
        """
        vectors = self._npz().vectors
        view = vectors.view()
        view.flags.writeable = False
        return view

    def signature(self) -> str | None:
        """Сигнатура кэша векторов (для проверки устаревания проекций)."""
        cache = self._npz()
        return cache.signature() if len(cache) > 0 else None

    # -- fragments ------------------------------------------------------------

    def fragments(self) -> list[dict[str, Any]]:
        """Метаданные ВСЕХ фрагментов корпуса (файл, строки, символ, язык).

        Порядок не гарантирован; сопоставляйте по id с .ids (векторы есть
        не у каждого фрагмента, если покрытие неполное).
        """
        with self.project._session() as session:
            rows = session.execute(
                select(FragmentRow, FileRow.rel_path, FileRow.root)
                .join(FileRow, FragmentRow.file_id == FileRow.id)
                .order_by(FileRow.rel_path, FragmentRow.start_line)
            ).all()
        return [
            {
                "id": frag.id,
                "file_id": frag.file_id,
                "rel_path": rel_path,
                "root": root,
                "kind": frag.kind,
                "name": frag.name,
                "symbol_path": frag.symbol_path,
                "parent_symbol_path": frag.parent_symbol_path,
                "start_line": frag.start_line,
                "end_line": frag.end_line,
                "method": frag.method,
                "language": frag.language,
            }
            for frag, rel_path, root in rows
        ]

    def fragment_text(self, fragment_id: str) -> str:
        """Исходный текст фрагмента (читается из файла корпуса по строкам)."""
        with self.project._session() as session:
            row = session.get(FragmentRow, fragment_id)
            if row is None:
                raise ProjectError(f"фрагмент '{fragment_id}' не найден")
            file_row = session.get(FileRow, row.file_id)
        if file_row is None:
            raise ProjectError(f"файл фрагмента '{fragment_id}' не найден")
        safe = resolve_safe_under_roots(file_row.abs_path, self.project.roots)
        if safe is None or not safe.is_file():
            raise ProjectError(
                f"файл '{file_row.rel_path}' недоступен (перемещён или вне корней проекта)"
            )
        lines = safe.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
        start = max(row.start_line - 1, 0)
        return "".join(lines[start : row.end_line])

    # -- derived artifacts -----------------------------------------------------

    def projections(self) -> list[dict[str, Any]]:
        """Запуски проекций этого пространства (метод, параметры, stale-флаг)."""
        live = self._live_signature()
        with self.project._session() as session:
            rows = session.execute(
                select(ProjectionRunRow)
                .where(ProjectionRunRow.embedding_run_id == self.id)
                .order_by(ProjectionRunRow.updated_at.desc())
            ).scalars()
            return [
                {
                    "id": r.id,
                    "method": r.method,
                    "n_components": r.n_components,
                    "params": json.loads(r.params_json or "{}"),
                    "seed": r.seed,
                    "axis_labels": json.loads(r.axis_labels_json or "[]"),
                    "count": r.count,
                    "stale": live is None or r.source_signature != live,
                    "cache_ok": (self.project.project_dir / r.npz_relpath).exists(),
                    "updated_at": r.updated_at,
                }
                for r in rows
            ]

    def projection(self, projection_run_id: str) -> dict[str, Any]:
        """Координаты проекции: ids (N,), coords (N, k) float32, подписи осей."""
        with self.project._session() as session:
            row = session.get(ProjectionRunRow, projection_run_id)
        if row is None or row.embedding_run_id != self.id:
            raise ProjectError(
                f"проекция '{projection_run_id}' не найдена в пространстве '{self.id}'"
            )
        cache = ProjectionCache.load(self.project.project_dir / row.npz_relpath)
        if cache is None:
            raise ProjectError(
                f"кэш координат проекции '{projection_run_id}' отсутствует или повреждён; "
                "пересчитайте проекцию в приложении"
            )
        return {
            "id": row.id,
            "method": row.method,
            "n_components": row.n_components,
            "seed": row.seed,
            "axis_labels": json.loads(row.axis_labels_json or "[]"),
            "axis_info": cache.axis_info,
            "ids": np.array(cache.ids, dtype=np.str_),
            "coords": cache.coords,
        }

    def clusters(self) -> list[dict[str, Any]]:
        """Запуски кластеризации этого пространства."""
        live = self._live_signature()
        with self.project._session() as session:
            rows = session.execute(
                select(ClusteringRunRow)
                .where(ClusteringRunRow.embedding_run_id == self.id)
                .order_by(ClusteringRunRow.updated_at.desc())
            ).scalars()
            return [
                {
                    "id": r.id,
                    "algorithm": r.algorithm,
                    "metric": r.metric,
                    "space": r.space,
                    "projection_run_id": r.projection_run_id,
                    "params": json.loads(r.params_json or "{}"),
                    "n_clusters": r.n_clusters,
                    "noise": r.noise,
                    "count": r.count,
                    "stale": live is None or r.source_signature != live,
                    "updated_at": r.updated_at,
                }
                for r in rows
            ]

    def clustering(self, clustering_run_id: str) -> dict[str, Any]:
        """Метки кластеров: ids (N,), labels (N,) int32, −1 = шум."""
        with self.project._session() as session:
            row = session.get(ClusteringRunRow, clustering_run_id)
        if row is None or row.embedding_run_id != self.id:
            raise ProjectError(
                f"кластеризация '{clustering_run_id}' не найдена в пространстве '{self.id}'"
            )
        loaded = load_labels(self.project.project_dir / row.npz_relpath)
        if loaded is None:
            raise ProjectError(
                f"кэш меток '{clustering_run_id}' отсутствует или повреждён; "
                "пересчитайте кластеризацию в приложении"
            )
        ids, labels = loaded
        return {
            "id": row.id,
            "algorithm": row.algorithm,
            "space": row.space,
            "ids": np.array(ids, dtype=np.str_),
            "labels": labels,
        }

    def neighbors(
        self, fragment_id: str, k: int = 10, metric: str = "cosine"
    ) -> list[dict[str, Any]]:
        """Точные k ближайших ЖИВЫХ соседей фрагмента (тот же расчёт, что в UI).

        Векторы удалённых фрагментов пропускаются, а список добирается из
        следующих кандидатов — поведение совпадает с REST API (audit #10).
        """
        cache = self._npz()
        index = cache.index_of(fragment_id)
        if index is None:
            raise ProjectError(
                f"фрагмент '{fragment_id}' не имеет вектора в пространстве '{self.id}'"
            )
        try:
            hits = knn(cache.vectors, index, k + max(8, k // 2), metric)
        except NeighborSearchError as exc:
            raise ProjectError(str(exc)) from exc
        neighbor_ids = [cache.ids[hit.index] for hit in hits]
        meta = {m["id"]: m for m in self._fragment_meta_by_ids(neighbor_ids)}
        out: list[dict[str, Any]] = []
        for hit, fid in zip(hits, neighbor_ids, strict=True):
            if fid not in meta:
                continue  # фрагмент удалён после расчёта векторов
            if len(out) >= k:
                break
            item: dict[str, Any] = {
                "rank": len(out) + 1,
                "fragment_id": fid,
                "score": float(hit.score),
                "distance": float(hit.distance),
            }
            item.update(
                {
                    key: meta[fid][key]
                    for key in (
                        "rel_path",
                        "kind",
                        "name",
                        "symbol_path",
                        "start_line",
                        "end_line",
                    )
                }
            )
            out.append(item)
        return out

    def _fragment_meta_by_ids(self, ids: list[str] | np.ndarray) -> list[dict[str, Any]]:
        id_list = [str(x) for x in ids]
        meta: list[dict[str, Any]] = []
        with self.project._session() as session:
            for start in range(0, len(id_list), 400):
                chunk = id_list[start : start + 400]
                rows = session.execute(
                    select(FragmentRow, FileRow.rel_path)
                    .join(FileRow, FragmentRow.file_id == FileRow.id)
                    .where(FragmentRow.id.in_(chunk))
                ).all()
                for frag, rel_path in rows:
                    meta.append(
                        {
                            "id": frag.id,
                            "rel_path": rel_path,
                            "kind": frag.kind,
                            "name": frag.name,
                            "symbol_path": frag.symbol_path,
                            "start_line": frag.start_line,
                            "end_line": frag.end_line,
                        }
                    )
        return meta

    def _live_signature(self) -> str | None:
        try:
            return self.signature()
        except ProjectError:
            return None


@dataclass
class ProjectHandle:
    """Открытый проект: манифест + read-only доступ к БД и кэшам."""

    manifest: ProjectManifest
    data_directory: Path
    _engine: Engine | None = field(default=None, repr=False)

    # -- identity --------------------------------------------------------------

    @property
    def id(self) -> str:
        return self.manifest.id

    @property
    def name(self) -> str:
        return self.manifest.name

    @property
    def roots(self) -> list[str]:
        return list(self.manifest.roots)

    @property
    def project_dir(self) -> Path:
        return self.data_directory / "projects" / self.manifest.id

    # -- workspace -------------------------------------------------------------

    @property
    def workspace_dir(self) -> Path:
        """Корень рабочего пространства документов (совпадает с cwd ядра)."""
        return self.project_dir / "workspace"

    @property
    def results_dir(self) -> Path:
        """Каталог для результатов экспериментов (создаётся по обращению)."""
        path = self.workspace_dir / "results"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def notes_dir(self) -> Path:
        path = self.workspace_dir / "notes"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def notebooks_dir(self) -> Path:
        path = self.workspace_dir / "notebooks"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # -- db (read-only) ----------------------------------------------------------

    def _get_engine(self) -> Engine:
        if self._engine is None:
            db_path = self.project_dir / "project.db"
            if not db_path.exists():
                raise ProjectError(f"база проекта '{self.id}' не найдена: {db_path}")
            # SQLite URI-формат: "file:<путь>?mode=ro" (на Windows — file:///C:/…).
            # Без file:-префикса SQLAlchemy/sqlite трактуют query иначе и могут
            # открыть пустую базу (проверено экспериментально).
            quoted = quote(db_path.as_posix(), safe="/:")
            prefix = "file:///" if os.name == "nt" else "file:"
            uri = f"sqlite:///{prefix}{quoted}?mode=ro&uri=true"
            try:
                engine = create_engine(uri)
                with engine.connect() as conn:
                    conn.exec_driver_sql("SELECT count(*) FROM sqlite_master")
            except Exception:
                # WAL-базу без живого -shm нельзя открыть строго read-only;
                # открываем обычно, но query_only запрещает запись на уровне SQL.
                engine = create_engine(f"sqlite:///{db_path.as_posix()}")
            self._engine = engine

            @event.listens_for(engine, "connect")
            def _read_only(dbapi_conn: Any, _record: Any) -> None:
                cursor = dbapi_conn.cursor()
                cursor.execute("PRAGMA query_only=ON")
                cursor.close()

        return self._engine

    @contextmanager
    def _session(self) -> Iterator[Session]:
        factory = sessionmaker(bind=self._get_engine())
        session = factory()
        try:
            yield session
        finally:
            session.close()

    def close(self) -> None:
        if self._engine is not None:
            self._engine.dispose()
            self._engine = None

    def __repr__(self) -> str:
        return f"<Project {self.id} name={self.name!r} roots={len(self.roots)}>"

    # -- info ----------------------------------------------------------------------

    def info(self) -> dict[str, Any]:
        """Сводка проекта: манифест, счётчики корпуса и пространств."""
        with self._session() as session:
            files = session.execute(select(func.count(FileRow.id))).scalar_one()
            fragments = session.execute(select(func.count(FragmentRow.id))).scalar_one()
            spaces = session.execute(select(func.count(EmbeddingRunRow.id))).scalar_one()
            projections = session.execute(select(func.count(ProjectionRunRow.id))).scalar_one()
        return {
            "id": self.id,
            "name": self.name,
            "roots": self.roots,
            "created_at": self.manifest.created_at,
            "updated_at": self.manifest.updated_at,
            "app_schema_version": SCHEMA_VERSION,
            "files": files,
            "fragments": fragments,
            "spaces": spaces,
            "projections": projections,
            "workspace_dir": str(self.workspace_dir),
        }

    # -- spaces ---------------------------------------------------------------------

    def list_spaces(self) -> list[dict[str, Any]]:
        """Векторные пространства (embedding runs): модель, режим, покрытие."""
        with self._session() as session:
            rows = session.execute(
                select(EmbeddingRunRow).order_by(EmbeddingRunRow.updated_at.desc())
            ).scalars()
            spaces = [
                {
                    "id": r.id,
                    "model_id": r.model_id,
                    "dim": r.dim,
                    "mode": r.mode,
                    "template": r.template,
                    "count": r.count,
                    "created_at": r.created_at,
                    "updated_at": r.updated_at,
                    "cache_ok": (self.project_dir / r.npz_relpath).exists(),
                }
                for r in rows
            ]
        if not spaces:
            return []
        return spaces

    def open_space(self, run_id: str | None = None) -> SpaceHandle:
        """Пространство по id; None — последнее по времени обновления."""
        spaces = self.list_spaces()
        if not spaces:
            raise ProjectError(
                f"в проекте '{self.name}' нет векторных пространств — сначала рассчитайте "
                "эмбеддинги в разделе EXPERIMENTS"
            )
        chosen: dict[str, Any] | None = None
        if run_id is None:
            chosen = spaces[0]
        else:
            for space in spaces:
                if space["id"] == run_id:
                    chosen = space
                    break
            if chosen is None:
                raise ProjectError(
                    f"пространство '{run_id}' не найдено; доступны: {[s['id'] for s in spaces]}"
                )
        return SpaceHandle(
            project=self,
            id=chosen["id"],
            model_id=chosen["model_id"],
            dim=chosen["dim"],
            mode=chosen["mode"],
            template=chosen["template"],
            count=chosen["count"],
            created_at=chosen["created_at"],
            updated_at=chosen["updated_at"],
        )

    # -- other research artifacts ---------------------------------------------------

    def relations(
        self,
        kind: str | None = None,
        origin: str | None = None,
        fragment_id: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Структурные связи (извлечённые/импортированные/ручные)."""
        with self._session() as session:
            stmt = select(RelationRow)
            if kind:
                stmt = stmt.where(RelationRow.kind == kind)
            if origin:
                stmt = stmt.where(RelationRow.origin == origin)
            if fragment_id:
                stmt = stmt.where(
                    (RelationRow.source_fragment_id == fragment_id)
                    | (RelationRow.target_fragment_id == fragment_id)
                )
            rows = session.execute(stmt.order_by(RelationRow.kind, RelationRow.id)).scalars()
            result = []
            for r in list(rows)[:limit]:
                result.append(
                    {
                        "id": r.id,
                        "kind": r.kind,
                        "origin": r.origin,
                        "confidence": r.confidence,
                        "detail": r.detail,
                        "source_file_id": r.source_file_id,
                        "source_fragment_id": r.source_fragment_id,
                        "target_file_id": r.target_file_id,
                        "target_fragment_id": r.target_fragment_id,
                    }
                )
            return result

    def slices(self) -> list[dict[str, Any]]:
        """Сохранённые математические срезы исходного пространства."""
        with self._session() as session:
            rows = session.execute(
                select(SavedSliceRow).order_by(SavedSliceRow.created_at)
            ).scalars()
            return [
                {
                    "id": r.id,
                    "name": r.name,
                    "embedding_run_id": r.embedding_run_id,
                    "normal_kind": r.normal_kind,
                    "normal_index": r.normal_index,
                    "dim": r.dim,
                    "position": r.position,
                    "thickness": r.thickness,
                    "plane_offset": r.plane_offset,
                    "created_at": r.created_at,
                }
                for r in rows
            ]

    def groups(self) -> list[dict[str, Any]]:
        """Ручные группы фрагментов (id, имя, состав)."""
        with self._session() as session:
            rows = session.execute(
                select(FragmentGroupRow).order_by(FragmentGroupRow.name)
            ).scalars()
            result = []
            for g in rows:
                members = session.execute(
                    select(FragmentGroupMemberRow.fragment_id).where(
                        FragmentGroupMemberRow.group_id == g.id
                    )
                ).scalars()
                result.append(
                    {
                        "id": g.id,
                        "name": g.name,
                        "created_at": g.created_at,
                        "fragment_ids": list(members),
                    }
                )
            return result

    def metrics(self) -> list[dict[str, Any]]:
        """Запуски метрик качества (значения — в metric(run_id))."""
        with self._session() as session:
            rows = session.execute(
                select(MetricRunRow).order_by(MetricRunRow.updated_at.desc())
            ).scalars()
            return [
                {
                    "id": r.id,
                    "embedding_run_id": r.embedding_run_id,
                    "projection_run_id": r.projection_run_id,
                    "k": r.k,
                    "sample_size": r.sample_size,
                    "seed": r.seed,
                    "n_vectors": r.n_vectors,
                    "created_at": r.created_at,
                }
                for r in rows
            ]

    def metric(self, metric_run_id: str) -> dict[str, Any]:
        """Полный результат запуска метрик (значения + пояснения)."""
        with self._session() as session:
            row = session.get(MetricRunRow, metric_run_id)
        if row is None:
            raise ProjectError(f"запуск метрик '{metric_run_id}' не найден")
        return {
            "id": row.id,
            "embedding_run_id": row.embedding_run_id,
            "projection_run_id": row.projection_run_id,
            "params": json.loads(row.params_json or "{}"),
            "result": json.loads(row.result_json or "{}"),
            "versions": json.loads(row.versions_json or "{}"),
        }

    def experiments(self) -> list[dict[str, Any]]:
        """Сохранённые эксперименты (краткая сводка)."""
        with self._session() as session:
            rows = session.execute(
                select(ExperimentRow).order_by(ExperimentRow.created_at.desc())
            ).scalars()
            return [
                {
                    "id": r.id,
                    "name": r.name,
                    "description": r.description,
                    "created_at": r.created_at,
                }
                for r in rows
            ]

    def experiment(self, experiment_id: str) -> dict[str, Any]:
        """Полный сохранённый эксперимент: config + snapshot."""
        with self._session() as session:
            row = session.get(ExperimentRow, experiment_id)
        if row is None:
            raise ProjectError(f"эксперимент '{experiment_id}' не найден")
        return {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "config": json.loads(row.config_json),
            "snapshot": json.loads(row.snapshot_json),
            "created_at": row.created_at,
        }


__all__ = [
    "ProjectError",
    "ProjectHandle",
    "SpaceHandle",
    "current",
    "data_dir",
    "list_projects",
    "load",
    "quickstart",
]
