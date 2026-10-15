# Руководство разработчика

Как настроить окружение, запускать тесты и линтеры, и расширять приложение.

## 1. Требования

- Python **3.11–3.13** (рекомендуется 3.12) — проверяется скриптом запуска;
- Node.js **≥ 20** (проверено на 24) и npm;
- Windows 10/11 (основная целевая ОС) либо Linux/macOS (скрипт `dev.sh`);
- ~4 ГБ свободной RAM; сеть — только для первой установки зависимостей.

## 2. Запуск

Одной командой из корня репозитория:

```powershell
# Windows
scripts\dev.bat
# или, если bat не подходит:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1
```

```bash
# Linux / macOS
./scripts/dev.sh
```

Скрипт: проверяет версии Python/Node → создаёт `backend/.venv` и ставит зависимости →
ставит npm-пакеты (`npm ci`) → запускает backend и frontend (на Windows — в двух
отдельных окнах) → открывает `http://localhost:5173`.

Полезные флаги `dev.ps1`: `-BackendPort 8001`, `-FrontendPort 5174`, `-SkipInstall`,
`-NoBrowser`. Остановка: закрыть окна / Ctrl+C.

Ручной запуск (если скрипт не используется):

```powershell
# backend (из backend/)
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt -r requirements-dev.txt
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# frontend (из frontend/)
npm ci
npm run dev
```

## 3. Тесты, линтеры, типы

### Все проверки одной командой

Из любого каталога репозитория:

```powershell
scripts\checks.bat            # Windows (или scripts/checks.ps1 из PowerShell)
```

Скрипт использует собственные окружения проекта (`backend\.venv`,
`frontend\node_modules`, создаются `dev.bat`/`dev.sh`) и печатает итоговую
таблицу. Флаги: `-BackendOnly`, `-FrontendOnly`.

### Backend (вручную)

Из каталога `backend/`, интерпретатором venv — в системном Python зависимостей
проекта может не быть:

```powershell
.venv\Scripts\python -m pytest          # юнит-тесты (138)
.venv\Scripts\python -m ruff check .    # линтер
.venv\Scripts\python -m ruff format --check .   # форматирование
.venv\Scripts\python -m mypy .          # строгая типизация
```

`pytest` можно запускать и из корня репозитория: `tests/conftest.py` добавляет
`backend/` в `sys.path`, а `pyproject.toml` задаёт `pythonpath = ["."]`.

Тесты с настоящей моделью помечены `real_model` и по умолчанию НЕ запускаются
(скачивание весов, нагрузка на RAM). Запуск вручную:

```powershell
.venv\Scripts\python -m pytest -m real_model
```

Они используют компактную `all-MiniLM-L6-v2` (~90 МБ): инференс и полный
E2E этапа 3 (эмбеддинги → PCA/UMAP → координаты сверяются с независимым
пересчётом PCA из сохранённых .npz). Модель по умолчанию
(`paraphrase-multilingual-MiniLM-L12-v2`, ~470 МБ) проверяется ручным
сценарием — это осознанное разделение, а не пропуск тестов. Первый запуск
UMAP-тестов медленнее: numba компилирует kernel'ы (~10–15 с один раз на процесс).

### Frontend (вручную)

Из каталога `frontend/` (в корне репозитория нет `package.json`):

```powershell
npm run test        # vitest (jsdom, 133 теста)
npm run lint        # eslint (flat config, typescript-eslint)
npm run typecheck   # tsc --noEmit, strict
npm run build       # production-сборка
```

Правила (ТЗ §17.6): тесты проверяют реальную логику; нельзя ослаблять или удалять тест
ради зелёного отчёта; каждое нетривиальное исправление сопровождается регрессионным
тестом.

### Windows-скрипты PowerShell — правила правки

`*.ps1` обязаны сохраняться в **UTF-8 with BOM** и использовать только
ASCII-пунктуацию (обычные кавычки и дефис). Без BOM Windows PowerShell 5.1
прочитает кириллицу как cp1251, а байты «умных» кавычек/тире сломают границы
строк и весь разбор файла. Оператор `&&` в PS 5.1 недоступен — использовать
`;` или отдельные вызовы.

## 4. Конфигурация (переменные окружения backend)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `ESE_HOST` | `127.0.0.1` | адрес интерфейса; не менять без необходимости |
| `ESE_PORT` | `8000` | порт backend |
| `ESE_DATA_DIR` | `~/.embedding-space-explorer` | каталог проектов/кэша |
| `ESE_FRONTEND_PORTS` | `5173` | порты фронтенда для CORS-allowlist (через запятую) |
| `ESE_BACKEND_URL` (frontend) | `http://127.0.0.1:8000` | цель прокси Vite `/api` |

## 5. Как расширять

Интерфейс вводится там, где ожидается несколько реализаций (см. `docs/architecture.md`
§3.2 — таблица модулей по этапам). Общая схема добавления:

- **Новый парсер/стратегия сегментации** — реализовать `Splitter`
  (`backend/app/fragmentation/base.py`: `split(text, options) -> SplitResult`),
  добавить язык в `LANGUAGE_CONFIGS` (tree-sitter) или `SPLITTER_BY_EXT` /
  `LANGUAGE_BY_EXT` (`registry.py`). Ядро не меняется. Обязательны тесты:
  диапазоны строк, stable ID, fallback при ошибках парсинга.
- **Новая embedding-модель** (sentence-transformers-рантайм) — добавить `ModelInfo`
  в `backend/app/embedding_providers/registry.py` (каталог): id, размерность,
  размер, ЧЕСТНОЕ описание ограничений. Другой рантайм (не ST) — новый класс
  `EmbeddingProvider` + ветка в `create_provider`. Кэш-ключи учитывают модель
  (fingerprint запуска), смешение векторов исключено; детали — `docs/data-model.md` §6.5.
- **Новый метод проекции** — реализовать `ProjectionMethod`
  (`backend/app/projection_methods/base.py`: `is_available()`, `fit(vectors,
  n_components, params, seed) -> ProjectionResult`), объявить параметры
  декларативно (`ParamSpec` — они же валидируются на сервере и рендерят
  UI-форму) и добавить экземпляр в `METHODS` (`registry.py`). Fingerprint
  кэша учитывает метод — координаты разных методов никогда не смешиваются;
  версии библиотек записываются в запуск автоматически (`library_versions`).
  Требования: детерминированность при фиксированных (вход, params, seed),
  честная оговорка об интерпретации (`caveat`), тяжёлые импорты — lazy.
  Обязательны тесты: геометрия на известном синтетическом наборе, guards на
  вырожденные входы, API-поток compute → points.
- **Новая метрика** — `metrics/` (этап 5): явные входы, определение положительных пар,
  текст-пояснение для UI.
- **Новый экспортёр** — `exporters/` (этап 5).
- **Новая панель UI** — компонент в `frontend/src/components/`, данные только через
  `src/api/client.ts`; состояние — в соответствующем zustand-store: интерфейс —
  `uiStore`, проект/корпус/общее выделение — `projectStore`, эксперименты
  (эмбеддинги, проекции) — `experimentStore`, состояние SPACE-представления —
  `spaceStore`. Чистую математику видов (пикнинг, рамки, тики) выносите в
  `src/space/` без импортов three.js — так она тестируется в jsdom.
  Monaco подключается «slim»
  (`src/monaco/setup.ts`): новый язык подсветки — импорт
  `monaco-editor/languages/definitions/<lang>/register`; language-сервисы
  (IntelliSense) не добавлять без необходимости — инспектор read-only.

До того как модуль создан, соответствующая строка плана в `docs/architecture.md` —
единственное место, где он упоминается; заранее пустые интерфейсы не создаются.

## 6. Зависимости

- Версии зафиксированы: `backend/requirements*.txt` (точные пины),
  `frontend/package-lock.json`.
- Новая зависимость добавляется только под конкретную задачу этапа, с обновлением
  lock-файлов и таблицы совместимости в `docs/architecture.md` §5.
- Регенерация пинов: чистое venv → `pip install <пакеты>` → `pip freeze`.

## 7. Стиль кода

- Python: аннотации типов обязательны (mypy strict), ruff (line-length 100),
  `from __future__ import annotations`, docstrings для публичных API.
- TypeScript: `strict`, `noUnusedLocals/Parameters`, type-only imports.
- UI: токены из `theme/tokens.css`, без инлайновых «магических» цветов; состояния
  загрузка/пусто/ошибка обязательны; не полагаться только на цвет (дублировать
  формой/маркером/подписью).
- Коммиты: небольшие, conventional commits (`feat(backend): …`, `docs: …`).
