# Архитектура Embedding Space Explorer

> Документ фиксирует архитектурные решения приложения. Разделы, помеченные «план»,
> описывают точки расширения и могут уточняться; реализованные помечены «реализовано».

## 1. Обзор

Приложение — локальный исследовательский инструмент для изучения embedding-пространств
исходного кода. Состоит из двух частей, обе выполняются на машине пользователя:

```
┌─────────────────────────── Браузер (localhost:5173) ───────────────────────────┐
│  Frontend: React 19 + TypeScript (strict) + Vite                               │
│  Zustand (единственный state-менеджер) · R3F/Drei · Monaco                     │
│  Все обращения к данным — только через типизированный API-клиент (`src/api`)   │
└───────────────────────────────────────┬────────────────────────────────────────┘
                                        │ HTTP /api/* (dev-прокси Vite → 127.0.0.1:8000)
┌───────────────────────────────────────▼────────────────────────────────────────┐
│  Backend: Python 3.11–3.13, FastAPI, слушает только 127.0.0.1                  │
│  api (HTTP-слой, DTO) → доменные модули → хранение (SQLite + .npz)             │
└────────────────────────────────────────────────────────────────────────────────┘
```

Внешние облачные сервисы не используются. Сеть нужна один раз — для установки
зависимостей и скачивания весов embedding-модели; после этого приложение
работает офлайн.

## 2. Ключевые принципы

1. **Локальность** — инференс и обработка исходников только на машине пользователя.
2. **Наблюдаемость** — любой результат связан с данными, моделью, параметрами и версиями.
3. **Воспроизводимость** — эксперимент хранит конфигурацию и fingerprint корпуса.
4. **Объяснимость** — каждая точка ведёт к фрагменту, файлу и диапазону строк; каждое
   отношение имеет тип и источник.
5. **Разделение понятий** — исходные эмбеддинги, проекции, срезы, кластеры и структурные
   отношения — разные сущности с разными типами; UI их не смешивает.
6. **Расширяемость** — новый парсер/модель/проекция/метрика подключаются локально,
   без переписывания ядра.

## 3. Backend

### 3.1. Структура (реализовано)

```
backend/
  app/
    __init__.py        # __version__, SCHEMA_VERSION — единый источник версий
    main.py            # create_app(): FastAPI-фабрика, lifespan, middleware, роутеры
    config.py          # Settings (host, port, data_dir, frontend_ports) из ESE_* env
    core/
      logging.py       # настройка логгера "ese" (без содержимого исходников в логах)
      security.py      # LocalOnlyMiddleware: Host/Origin-проверки (loopback-only)
    api/
      schemas.py       # Pydantic-DTO: HealthResponse, ErrorResponse и др.
      routes_health.py # GET /api/health — диагностика
  tests/               # pytest: health, security
  pyproject.toml       # конфигурация ruff / mypy (strict) / pytest
  requirements.txt     # точные версии рантайм-зависимостей (lock)
  requirements-dev.txt # точные версии dev-зависимостей (pytest, ruff, mypy, httpx)
```

### 3.2. Доменные модули

Модули вводятся по мере необходимости — интерфейс появляется там, где ожидается
несколько реализаций:

| Модуль | Назначение |
|---|---|
| `source_registry/` ✅ | безопасное сканирование корней (симлинки, секреты, бинарники, лимиты), детектор изменений (size/mtime → sha256) |
| `fragmentation/` ✅ | интерфейс сегментации + адаптеры: tree-sitter (Python/JS/TS/TSX), Markdown-секции, fallback-чанки; стабильные ID |
| `storage/` ✅ | SQLAlchemy + SQLite (WAL): files/fragments/jobs/meta, версионирование схемы, бэкап перед миграцией |
| `jobs/` ✅ | JobManager: очередь, один worker-поток, прогресс, отмена, предупреждения |
| `embedding_providers/` ✅ | интерфейс провайдера + sentence-transformers (CPU, batching, прогресс, отмена); каталог моделей; lazy-import тяжёлых библиотек |
| `vector_store/` ✅ | .npz-кэш векторов на запуск (ids/text_hashes/frag_hashes/vectors), атомарная запись, upsert/prune |
| `projection_methods/` ✅ | интерфейс метода + каталог; PCA (sklearn, full SVD — детерминированная), UMAP (lazy numba, seeded), raw_axes (точные координаты выбранных измерений исходного пространства + standardize); декларативные спецификации параметров, включая int_list (валидация и UI-форма из одного источника); .npz-кэш координат на запуск; пресеты форм (projection_presets, db v4) |
| `slice_engine/` ✅ | математический срез: `d(x) = dot(x − p, n)`, слой `|d| ≤ t/2` в исходном D-мерном пространстве; нормали MVP: ось пространства / направление PCA (детерминированный full-SVD) / явный вектор (его сохраняют saved-срезы — воспроизводимость) |
| `neighbor_search/` ✅ | точный kNN (brute-force numpy) по ИСХОДНЫМ эмбеддингам, метрика cosine (по умолчанию) / euclidean; self исключается; score+distance |
| `relation_providers/` ✅ | структурные отношения: извлечение tree-sitter (imports py/js/ts/tsx с честным разрешением модулей в файлы; belongs_to по parent_symbol_path; концы — файл И/ИЛИ фрагмент), импорт формата `ese-relations/v1` с построчным отчётом, ручные; provenance (extracted/imported/manual) не смешивается |
| `clustering_methods/` ✅ | DBSCAN (sklearn) по ЯВНОМУ пространству: исходные векторы (cosine/euclidean) или координаты одной проекции (только euclidean); метки −1 = шум (не «смысл»); fingerprint-идемпотентность, .npz-кэш меток, stale по подписи векторов |
| `metrics/` ✅ | neighbor retention (исходное cosine → проекция euclidean), trustworthiness (sklearn, k < N/2, честное k при малой выборке), precision/R-precision/coverage по ИЗВЕСТНЫМ структурным связям с правилами неполноты корпуса (неизвестная пара ≠ негатив; нет данных → null + warning) + baseline случайного ранжирования и lift; детерминированная выборка (seed), каждое значение с пояснением |
| `experiment_manager/` ✅ | сохранённые эксперименты: валидация ссылок при сохранении (400 со списком), снимок контекста (корпус, версии, устаревание, значения метрик), live-статус при открытии (missing/stale перечисляются, не подменяются); сравнение — из двух конфигов на клиенте |
| `exporters/` ✅ | CSV (BOM для Excel)/JSON: точки проекции, связи с фильтрами, выделение, метрики, эксперимент (конфиг+снимок+live-статус); PNG сцен — клиентский захват живого canvas |
| `workspace/` ✅ | исследовательское рабочее пространство проекта (`<project>/workspace/`: notebooks, notes, datasets, results, exports, latex): относительные пути с проверкой относительно корня (traversal/симлинки), атомарная запись UTF-8, optimistic-concurrency (`base_mtime` → 409), открытие папки в файловом менеджере ОС (только фиксированные подкаталоги); бинарная отдача `GET /raw` (изображения заметок, PDF: ≤32 МБ, inline, `text/html`→`text/plain` + nosniff); документы НЕ входят в embedding-корпус |
| `notebooks/` ✅ | Jupyter-блокноты: формат `.ipynb` через `nbformat` (стандарт Jupyter, валидация с проблемами вместо падений, нормализация id ячеек при сохранении, неизвестные MIME-выводы сохраняются), KernelSessionManager — одно долгоживущее ядро ipykernel на (проект, блокнот): cwd = workspace, PYTHONPATH = backend (пакет `ese`), interrupt/restart, idle-TTL reap, лимит сессий, shutdown в lifespan; выполнение — поток на сессию + polling (как у jobs, без WebSocket), вывод ограничен (~2 МБ) |

Правило границ: `api/` содержит только HTTP-слой и DTO; доменные модули не знают про
FastAPI; хранение изолировано за интерфейсами. Панели фронтенда не обращаются к
вычислительным модулям иначе чем через API.

### 3.3. Долгие операции (план)

Сегментация, эмбеддинги, проекции, кластеризация выполняются как фоновые задачи:
`POST …/jobs` → `task_id`, далее polling `GET /api/tasks/{id}` (статус, этап, прогресс,
предупреждения, отмена). HTTP-запрос не держит долгие вычисления. WebSocket не
используется, пока polling достаточен.

### 3.4. Хранение данных

```
<data_dir>/                     # по умолчанию ~/.embedding-space-explorer
  projects/<project-id>/
    project.db                  # SQLite: метаданные, фрагменты, отношения, задачи, эксперименты
    project.json                # манифест проекта (корни, настройки, версия схемы)
    cache/
      fragments/  embeddings/  projections/  neighbors/  clustering/
    experiments/<experiment-id>/{config.json, metrics.json, notes.md, exports/}
    exports/
    logs/
    workspace/                  # исследовательские документы (notebooks/notes/datasets/results/exports/latex)
```

- Векторы и координаты — бинарные `.npy/.npz` файлы; метаданные — SQLite.
- Исходники пользователя **не копируются** в проект (читаются из выбранных корней).
- Схема БД версионируется (`SCHEMA_VERSION` в `app/__init__.py`), миграции с резервной
  копией БД перед применением.
- Ключ кэша эмбеддинга = hash(подготовленный текст) + режим подготовки + id/версия модели
  + параметры инференса. Изменения UI никогда не инвалидируют кэш.

### 3.5. Безопасность (реализовано)

- Uvicorn запускается только на `127.0.0.1` (переопределяется `ESE_HOST`; при
  нелокальном адресе health честно показывает `loopback_only: false` и UI warns).
- `LocalOnlyMiddleware`:
  - `Host`-заголовок обязан быть loopback (`127.0.0.1`, `localhost`, `::1`) — иначе 403
    `forbidden_host` (защита от DNS rebinding);
  - для изменяющих методов при наличии `Origin` он обязан быть локальным — иначе 403
    `forbidden_origin` (защита от CSRF-сценариев);
- CORS-allowlist — только `http://localhost:<frontend_port>` и `http://127.0.0.1:<…>`;
- API не предоставляет произвольный доступ к файловой системе (доступ
  ограничивается явно выбранными корнями, с защитой от `../`, абсолютных путей и
  симлинков наружу);
- код исследуемого проекта не выполняется; телеметрия отсутствует; логи не содержат
  содержимое исходников. Исключение по замыслу — Notebook: пользовательский Python
  выполняется в ядре ipykernel с правами пользователя, запустившего приложение
  (осознанная граница локального инструмента, задокументирована в README); основное
  хранилище проекта ядро читает read-only (SQLite `mode=ro` + `PRAGMA query_only`).

### 3.6. Ядра Notebook и мост `ese` (реализовано)

- Одно долгоживущее ядро ipykernel на пару (проект, блокнот); переменные живут
  между ячейками. Сессия привязана к resolved-пути `.ipynb`: одинаковые имена
  файлов в разных проектах — разные сессии.
- Ядро запускается с `cwd = <project>/workspace` (стабильно, не зависит от
  каталога запуска backend) и `PYTHONPATH = backend/` — в коде ячейки доступны
  пакеты `ese` (мост к данным) и `app` (доменные модули приложения).
- `ese.project` (backend/ese/) — документированный read-only интерфейс к данным
  проекта из Python: `current()` / `load(id)` / `list_projects()`;
  `info()`, `list_spaces()`, `open_space()` → `embeddings()` (ленивая загрузка
  .npz), `ids`, `fragments()`, `fragment_text()`, `projections()/projection()`,
  `clusters()/clustering()`, `neighbors()` (переиспользует `neighbor_search.knn`),
  `relations()`, `slices()`, `groups()`, `metrics()`, `experiments()`;
  `results_dir/notes_dir/notebooks_dir` — каталоги workspace для сохранения
  результатов экспериментов (основное хранилище не перезаписывается).
- Выполнение: поток на сессию, сбор iopub-сообщений (stream/execute_result/
  display_data/error/update_display_data) в nbformat-совместимые outputs,
  лимит ~2 МБ на выполнение, interrupt (KeyboardInterrupt), restart со сбросом
  состояния, детекция мёртвого ядра, idle-TTL (30 мин) и лимит одновременных
  сессий (4; `ESE_KERNEL_SESSION_LIMIT`/`ESE_KERNEL_IDLE_TTL`), shutdown всех
  ядер в lifespan приложения.
- Метаданные блокнота: `metadata.ese.project_id` фиксирует проект создания
  (воспроизводимость); при открытии в другом проекте UI показывает честное
  предупреждение — ядро всегда работает с ТЕКУЩИМ проектом.

## 4. Frontend

### 4.1. Структура (реализовано)

```
frontend/src/
  main.tsx              # точка входа (+ monaco/setup — офлайн, slim)
  App.tsx               # app-shell: TopBar / (Space | Experiments | Diagnostics | Start) / StatusBar
  api/                  # types.ts (зеркало DTO backend), client.ts (ApiError code/hint)
  state/
    uiStore.ts          # подключение, диагностика, активная секция
    projectStore.ts     # проект, файлы, выделение (activeFragmentId + selectedFragmentIds), changes, задачи
    experimentStore.ts  # модель/режим/запуски эмбеддингов + каталог/форма/инвентарь проекций
    spaceStore.ts       # облака точек (raw+display буферы), список 2D-графиков, hover, режим вида, срез 4D
  monaco/
    setup.ts            # loader.config(monaco) — без CDN; editor.api + 4 языка; тема ese-dark
    helpers.ts          # чистые функции: язык, декорации, бейджи kind (тестируются без monaco)
  markdown/
    renderMarkdown.ts   # общий Markdown+LaTeX→HTML (marked+KaTeX+DOMPurify): ячейки блокнота,
                        # предпросмотр заметок; code-зоны защищены от математики, \$ не открывает формулу
    ansi.ts             # ANSI-цвета traceback'ов → HTML
    workspaceImages.ts  # относительные <img src> заметок → GET /workspace/raw (относительно каталога документа)
  space/
    selectionMath.ts    # чистая математика: fit (в т.ч. strided 4D→3D)/NDC-рамка/хит-тест/тики/
                        # canvas-маппинг/окно 4D-слоя/зум-панорама 2D (без three.js)
    axisSpec.ts         # парсер поля осей raw_axes: «12, 57» и мульти-форма «0,1;0,2» (≤6 пар)
    sliceMath.ts        # клиентская половина среза: |u − position| ≤ t/2, маски dim/only, guard чужого запуска
    clusterColor.ts     # детерминированная палитра кластеров + текстовые ключи легенды («кластер N»/«шум»)
    relationLabels.ts   # текстовые бейджи/глифы/цвета типов связей, лимит линий на сцене
    palette.ts          # единый источник цветов данных (фрагменты/файлы/сетка/сцена) + легенда;
                        # зеркалит theme/tokens.css (palette.test.ts сверяет — расхождение ловится)
    fileColor.ts        # окраска точек по типу файла (расширению) — тот же цвет, что у бейджа в дереве
    gridMath.ts         # чистая математика координатной сетки: обратный фит (display→raw), подписи делений 3D
    fragmentRef.ts      # PointMeta → FragmentMeta (id/file_id; остальное догружает корпус)
    projectionLabels.ts # честные подписи запусков проекций (устарела/кэш повреждён)
  components/
    corpus/             # CorpusPanel, FileTree, FragmentList, SelectedFragmentCard, JobProgress
    inspector/          # SourceInspector (Monaco read-only + locator-бар)
    analysis/           # NeighborsTab / RelationsTab / ClustersTab (левая панель SPACE) + AnalysisJobPoller
    relations/          # RelationsSection: браузер связей, извлечение, импорт ese-relations/v1, ручные
    research/           # RESEARCH: WorkspacePanel+WorkspaceTree, DocumentHost, NotebookEditor
                        # (+NotebookCell/CellOutputs/EseHelpDialog), MarkdownEditor+CrepeHost
                        # (WYSIWYG Milkdown Crepe) — редакторы .ipynb и .md, диалоги, дерево
    space/              # SpaceSection (Allotment-компоновка), SliceControls (срез исходного пространства),
                        # ViewBar (переключатель 3D/2D/4D/3D+2D, селекторы проекций активного
                        # режима, удаление, переключатели окраски «тип/файл/кластер» и координатной
                        # сетки «выкл/простая/цифры», экспорт), PointScene (общая R3F-сцена:
                        # Shift-рамка, Ctrl-точка, легенда, тултип, сетка и её подписи),
                        # Scene3D / Scene4D (слайдер «времени»),
                        # Projection2D (canvas: несколько графиков рядом, зум/панорама, сетка),
                        # ProjectionControls (+ ExperimentJobPoller)
    TopBar / SectionTabs / StatusBar / DiagnosticsPanel / ConnectionIndicator
    StartScreen / FolderPickerDialog / ChangesDialog
    ExperimentsPanel    # модель, режим подготовки, расчёт, запуски эмбеддингов
  theme/tokens.css      # дизайн-токены: палитра (поверхности/границы/текст/акцент),
                        # цвета данных (файлы/фрагменты/сетка), типографика, размеры
  theme/fonts.css       # собственные шрифты (JetBrains Mono + Inter, woff2 latin/cyrillic, OFL) — без CDN
  styles/global.css     # базовые стили + корпус/инспектор/модалки/декорации Monaco/пространство
```

### 4.2. Состояние

Единственный state-менеджер — **zustand** (конкурирующие подходы не
вводятся). Разделение store'ов по назначению:

- `uiStore` — подключение, диагностика, активная секция;
- `projectStore` — открытый проект, файлы, `activeFragmentId` +
  `selectedFragmentIds` (общий selection state всех представлений), located-фрагменты,
  changes/staleness, активная задача;
- `experimentStore` — каталог моделей, режим подготовки, форма расчёта,
  задача эмбеддингов, инвентарь запусков; каталог методов проекции, форма (метод/
  параметры из серверных спецификаций/seed/поле осей с мульти-синтаксисом «0,1;0,2»),
  инвентарь проекций, задача проекции (+ pendingBuild — что показал после финиша),
  удаление проекций (одной/всех), пресеты (save/apply/delete);
- `analysisStore` — соседи активной точки, связи (вкладка + браузер),
  кластерные запуски и ручные группы, сохранённые срезы, собственный канал
  фоновых задач (извлечение связей, кластеризация) с polling;
- `spaceStore` — интерфейсное состояние SPACE: загруженные облака точек
  (raw-координаты + view-only display-буфер; для 4D-облака display строится по первым
  трём осям), активные проекции 3D/2D (2D — СПИСОК облаков для графиков рядом)/4D,
  hover, размер точек, режим вида (3d/2d/4d/split), режим координатной сетки
  (off/simple/numbers), состояние окна 4D («время»:
  позиция/толщина/анимация), оверлей среза исходного пространства (u-массив +
  позиция/толщина + режим dim/only/off), раскраска (тип/файл/кластер + метки +
  подпись запуска), линии связей. Режимов взаимодействия нет: рамка включается
  удержанием Shift в самой сцене. Координаты — только с сервера.

- `researchStore / notebookStore / markdownStore` — раздел RESEARCH: дерево документов
  workspace и файловые операции (привязка к проекту, защита от stale-ответов); открытый
  `.ipynb` + сессия ядра + выполнения ячеек (polling); открытая `.md`-заметка (4 режима
  редактора, dirty честным сравнением с сохранённым текстом, конфликт `base_mtime`,
  внешняя перечитка при фокусе окна, тихий flush в СВОЙ проект при переключении).

`activeFragmentId`/`selectedFragmentIds` — точка синхронизации 3D-сцены, 2D-проекции,
списка фрагментов и Monaco по **id фрагмента**.

### 4.3. Модули UI

- `app-shell` — каркас: TopBar, StatusBar, переключение секций;
- `fragment-explorer` + `source-inspector` — корпус и Monaco read-only с обратной
  трассировкой выделения;
- `task-status` — JobProgress + polling фоновых задач;
- `space-view` — R3F: один объект точек с буферными атрибутами, без компонента на
  точку; hover/клик/Ctrl-клик/Shift-рамка, легенда, состояния; общий PointScene для
  3D и 4D, маска видимости/затемнение (окно 4D + срез), раскраска по кластерам,
  линии связей с фильтрами и лимитом;
- `projection-view` — canvas 2D с осями/тиками, зум/панорама, несколько графиков
  рядом, срез/кластеры, тот же selection state;
- `relations-panel` — вкладка левой панели + секция RELATIONS: браузер, извлечение,
  импорт, ручные связи;
- `slice-controls` — панель математического среза;
- `experiment-controls` — эмбеддинги, проекции, кластеризация, группы, сохранённые
  эксперименты со сравнением;
- `metrics-panel` — сворачиваемая панель под «Срезом» (метрики вторичны по отношению
  к пространству);
- `export-menu` — ViewBar: PNG живых сцен, CSV точек/выделения/связей; JSON метрик и
  экспериментов — в их панелях.

Панели размещаются через Allotment; SPACE использует компоновку
«корпус | панель видов + сцены + панель построения | инспектор»; отдельной секции
CORPUS нет — её панели живут внутри SPACE.

### 4.4. Честность интерфейса

Интерфейс не выдаёт желаемое за действительное: отсутствующие данные показываются как
«нет данных», а не как нули; устаревшие проекции и векторы помечаются явно; происхождение
связей и слоёв подписывается. Демо-данные в основном сценарии запрещены; синтетические
векторы используются только в тестах.

## 5. Версии и совместимость

| Компонент | Версия | Комментарий |
|---|---|---|
| Python | 3.11–3.13 (целевая у пользователя — 3.12) | проверяется скриптом запуска |
| Node.js | ≥ 22.12 (у пользователя 24) | проверяется скриптом запуска (vitest 5 / vite 8) |
| fastapi / pydantic / uvicorn | 0.143.1 / 2.14.1 / 0.54.0 | точные пины в requirements.txt |
| sqlalchemy / tree-sitter | 2.1.4 / 0.26.0 (+ языки: python 0.25.0, javascript 0.25.0, typescript 0.23.2) | Windows-колёса cp312/abi3 проверены по PyPI |
| react / vite / typescript | 19.3.1 / 8.3.4 / 5.9.3 | package-lock.json; TS7 пока не поддерживается typescript-eslint (<6.1.0), поэтому 5.9 |
| monaco-editor / allotment | 0.57.0 / 1.20.6 | monaco — «slim»: editor.api + monarch-токенайзеры python/js/ts/md, без TS/JSON/CSS/HTML language-сервисов (read-only просмотр, экономия RAM/сборки) |
| @milkdown/crepe | 7.22.3 ✅ | WYSIWYG-редактор заметок (ProseMirror + CodeMirror 6 + встроенный Latex/KaTeX + vue для table-nodeview); katex дедуплицирован с приложением (0.19.0); грузится ленивым chunk'ом — основной бандл не растёт |
| torch / sentence-transformers | 2.14.1+cpu / 6.1.0 ✅ | torch только CPU (+extra-index-url download.pytorch.org); 8 ГБ RAM: batch size по умолчанию 16, прогресс и отмена между батчами |
| scikit-learn / umap-learn | 1.9.1 / 0.5.12 ✅ | umap тянет numba 0.68.0 + llvmlite 0.50.0 + pynndescent 0.6.0; совместимость с numpy 2.4.6 проверена; первый импорт numba медленный (~10 с) — lazy |
| three / @react-three/fiber / @react-three/drei | 0.186.1 / 9.8.2 / 10.7.9 ✅ | R3F 9 — линия для React 19 (peer >=19 <19.4); @types/three в devDependencies |
| tree-sitter-language-pack | 1.22.1 (план) | больше языков сегментации — после MVP |

Зависимости добавляются только когда задача реально их использует; версии фиксируются
lock-файлами. Приложение не требует GPU, Docker, облачных аккаунтов и прав администратора.

## 6. Порты и запуск

- Backend: `http://127.0.0.1:8000` (env `ESE_HOST`, `ESE_PORT`).
- Frontend (dev): `http://localhost:5173` (Vite, strictPort), прокси `/api` → backend
  (адрес переопределяется `ESE_BACKEND_URL`).
- Каталог данных: `~/.embedding-space-explorer` (env `ESE_DATA_DIR`).
- Запуск одной командой: `scripts\dev.bat` (Windows) / `scripts/dev.sh` (POSIX).
