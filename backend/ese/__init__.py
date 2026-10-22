"""ese — Python-мост к данным проекта Embedding Space Explorer.

Этот пакет импортируется внутри ядер Jupyter, запущенных приложением
(PYTHONPATH ядра включает каталог backend). Он даёт Notebook-коду
документированный доступ к УЖЕ РАССЧИТАННЫМ данным проекта — векторным
пространствам, проекциям, кластерам, связям, метрикам и экспериментам —
через те же модели хранения (SQLite + .npz), которые использует приложение.
Никакой второй системы хранения: данные читаются из основного хранилища
и не копируются в блокнот.

Быстрый старт (ядро уже знает свой проект — ESE_PROJECT_ID)::

    from ese import project

    p = project.current()               # проект этого ядра
    p.info()                            # имя, корни, счётчики
    spaces = p.list_spaces()            # векторные пространства (embedding runs)
    sp = p.open_space(spaces[0]["id"])  # или p.open_space() — последнее

    X = sp.embeddings()                 # (N, D) float32 — загрузка по запросу;
                                        # массив read-only: для правок — X.copy()
    ids = sp.ids                        # id фрагментов, тот же порядок
    frags = sp.fragments()              # метаданные: файл, строки, символ…
    text = sp.fragment_text(ids[0])     # исходный текст фрагмента

    proj = sp.projection(sp.projections()[0]["id"])   # координаты проекции
    lab = sp.clustering(sp.clusters()[0]["id"])       # метки кластеров
    nb = sp.neighbors(ids[0], k=5)                    # точные соседи

    # Результаты экспериментов сохраняйте в рабочем пространстве:
    out = p.results_dir / "my_experiment.npz"
    # ... np.savez(out, ...)

Доступ к ДРУГОМУ проекту — только явный: ``project.load("<project-id>")``.
Все операции чтения; основное хранилище не изменяется (SQLite открывается
read-only / query_only). Произвольный Python-код в ядре выполняется с
правами пользователя, запустившего приложение, — это осознанная граница
локального инструмента (см. README, «Безопасность»).
"""

from __future__ import annotations

from ese import project as _project

__all__ = ["project", "quickstart"]

#: `import ese; ese.quickstart()` — не затеняем встроенный help().
quickstart = _project.quickstart
