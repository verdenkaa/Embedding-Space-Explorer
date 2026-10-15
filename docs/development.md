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

### Backend (из каталога `backend/`, в активированном `.venv`)

```powershell
.venv\Scripts\python -m pytest          # юнит-тесты
.venv\Scripts\python -m ruff check .    # линтер
.venv\Scripts\python -m ruff format --check .   # форматирование
.venv\Scripts\python -m mypy .          # строгая типизация
```

### Frontend (из каталога `frontend/`)

```powershell
npm run test        # vitest (jsdom)
npm run lint        # eslint (flat config, typescript-eslint)
npm run typecheck   # tsc --noEmit, strict
npm run build       # production-сборка
```

Правила (ТЗ §17.6): тесты проверяют реальную логику; нельзя ослаблять или удалять тест
ради зелёного отчёта; каждое нетривиальное исправление сопровождается регрессионным
тестом.

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

- **Новый парсер/стратегия сегментации** — реализовать интерфейс фрагментатора
  (`backend/app/fragmentation/`, появится на этапе 1) и зарегистрировать адаптер;
  ядро не меняется. Обязательны тесты: stable ID, диапазоны строк, fallback.
- **Новая embedding-модель** — реализовать интерфейс провайдера
  (`backend/app/embedding_providers/`, этап 2): id/версия модели, размерность, параметры
  инференса. Кэш-ключи учитывают провайдера, поэтому смешения векторов не произойдёт.
- **Новый метод проекции** — интерфейс `projection_methods` (этап 3): имя метода,
  параметры, seed, версии библиотек сохраняются в конфиге проекции.
- **Новая метрика** — `metrics/` (этап 5): явные входы, определение положительных пар,
  текст-пояснение для UI.
- **Новый экспортёр** — `exporters/` (этап 5).
- **Новая панель UI** — компонент в `frontend/src/components/`, данные только через
  `src/api/client.ts`; состояние — в соответствующем zustand-store.

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
