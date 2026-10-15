# Embedding Space Explorer

Локальный исследовательский инструмент для изучения embedding-пространств исходного кода:
загрузите папку проекта, постройте эмбеддинги фрагментов локальной моделью, исследуйте
геометрию (проекции, математические срезы, кластеры, соседи) и в любой момент проследите
**точку → фрагмент → файл и строки** и обратно.

Всё выполняется локально: без облака, аккаунтов и телеметрии.

> **Статус: Этап 0 (каркас).** Сейчас работают: запуск одной командой, локальный backend
> с защитой loopback-only и диагностика (`/api/health`), интерфейс-оболочка в стиле тёмной
> исследовательской IDE, тесты/линтеры/документация. Разделы SPACE, CORPUS, RELATIONS,
> EXPERIMENTS появятся на этапах 1–5 (см. [Дорожная карта](#дорожная-карта)) — в интерфейсе
> они честно помечены как недоступные.

## Требования

| Компонент | Версия | Примечание |
|---|---|---|
| ОС | Windows 10/11 | Linux/macOS поддерживаются скриптом `dev.sh` |
| Python | 3.11–3.13 (рекомендуется 3.12) | при установке отметьте «Add python.exe to PATH» |
| Node.js | ≥ 22.12 (LTS) | https://nodejs.org/ |
| RAM | ~4 ГБ свободных | GPU не требуется |
| Сеть | только для первой установки | зависимости + (на этапе 2) веса модели |

## Быстрый старт (Windows)

```powershell
git clone https://github.com/verdenkaa/Embedding-Space-Explorer.git
cd Embedding-Space-Explorer
scripts\dev.bat
```

Либо, если `.bat` не сработал (политика выполнения скриптов):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1
```

Скрипт проверит окружение, при первом запуске установит зависимости (несколько минут),
затем откроет два окна — **ESE backend** и **ESE frontend** — и откроет браузер на
`http://localhost:5173`. Остановка: закрыть оба окна.

Полезные параметры: `-BackendPort 8001`, `-FrontendPort 5174`, `-SkipInstall`, `-NoBrowser`.

Linux/macOS: `./scripts/dev.sh` (остановка — Ctrl+C).

### Что вы увидите на этапе 0

Интерфейс-оболочку: верхняя панель с (пока недоступными) разделами и индикатором
подключения, панель диагностики backend — версия приложения, Python, платформа, каталог
данных, результаты проверок и честный статус зависимостей будущих этапов, нижняя строка
состояния. Если backend не запущен — панель покажет понятную ошибку и кнопку «Повторить».

Полезные адреса:

- интерфейс: `http://localhost:5173`
- диагностика: `http://127.0.0.1:8000/api/health`
- Swagger: `http://127.0.0.1:8000/api/docs`

## Тесты и проверки

Всё одной командой, из любого каталога (использует собственные окружения проекта):

```powershell
scripts\checks.bat
```

Прогоняет pytest / ruff / ruff format / mypy для backend (через `backend\.venv`)
и vitest / eslint / tsc / build для frontend (через `frontend\node_modules`),
печатает итоговую таблицу и возвращает ненулевой код при провале.
Флаги: `-BackendOnly`, `-FrontendOnly`.

> `backend\.venv` и `frontend\node_modules` создаёт `scripts\dev.bat` при первом
> запуске. `.venv` находится **внутри `backend\`**, а не в корне репозитория.

Ручной запуск отдельных проверок:

Backend — из каталога `backend\`, интерпретатором venv (в системном Python
зависимостей проекта может не быть):

```powershell
cd backend
.venv\Scripts\python -m pytest        # 38 тестов: health, security, config
.venv\Scripts\python -m ruff check .  # линтер
.venv\Scripts\python -m mypy .        # строгая типизация
```

Frontend — из каталога `frontend\` (в корне репозитория нет package.json):

```powershell
cd frontend
npm run test        # 9 тестов: API-клиент, состояния интерфейса, регрессия polling-цикла
npm run lint        # eslint
npm run typecheck   # tsc --noEmit (strict)
npm run build       # production-сборка
```

`pytest` благодаря бутстрапу в `tests/conftest.py` работает и из корня
репозитория, но канонический способ — из `backend\` интерпретатором venv.

## Структура репозитория

```
backend/            Python/FastAPI: API, конфигурация, security-middleware, тесты
  app/
    api/            HTTP-слой: schemas.py (DTO), routes_health.py, deps.py
    core/           security.py (loopback-only), logging.py
    config.py       настройки из ESE_* переменных окружения
  tests/            pytest
frontend/           React 19 + TypeScript (strict) + Vite
  src/api/          типизированный клиент (единственный канал к backend)
  src/state/        zustand-store (единственный state-менеджер)
  src/components/   TopBar, DiagnosticsPanel, StatusBar, …
docs/               architecture.md, development.md
scripts/            dev.bat / dev.ps1 / dev.sh — запуск одной командой
```

## Безопасность

- Backend слушает **только 127.0.0.1**; запросы с нелокальным `Host` отклоняются (защита
  от DNS rebinding), изменяющие запросы с нелокальным `Origin` — тоже (CSRF).
- CORS разрешён только для локального фронтенда.
- Телеметрии нет; исходники никуда не отправляются.

## Дорожная карта

| Этап | Содержание | Статус |
|---|---|---|
| 0 | Каркас, запуск одной командой, диагностика, безопасность | ✅ готов |
| 1 | Корпус: сканирование папки, tree-sitter-сегментация, стабильные ID фрагментов, Monaco-инспектор, отслеживание изменений | в работе |
| 2 | Эмбеддинги: sentence-transformers на CPU, raw / context-enriched режимы, кэш | — |
| 3 | Пространство: PCA/UMAP, 3D-сцена (R3F) + синхронная 2D-проекция, выделение | — |
| 4 | Математические срезы, соседи, структурные отношения, кластеры, ручные группы | — |
| 5 | Метрики, эксперименты, экспорт | — |
| 6 | Стабилизация и приёмка | — |

## Документация

- [docs/architecture.md](docs/architecture.md) — модули, потоки данных, границы, точки расширения
- [docs/development.md](docs/development.md) — окружение, тесты, линтеры, как расширять
- [CHANGELOG.md](CHANGELOG.md) — журнал изменений

## Устранение неполадок

| Симптом | Решение |
|---|---|
| «Не найден Python 3.11–3.13» | Установите Python 3.12 с python.org, отметьте «Add to PATH», перезапустите скрипт |
| «Не найден Node.js» / старый Node | Установите LTS с nodejs.org |
| Порт 8000/5173 занят | Закройте прошлый запуск или стартуйте с `-BackendPort`/`-FrontendPort` |
| Окна открылись и закрылись | Запустите скрипт из PowerShell и прочитайте вывод; проверьте `npm ci` вручную в `frontend/` |
| Интерфейс открылся, но «Backend недоступен» | Дождитесь запуска в окне ESE backend; нажмите «Повторить»; проверьте `http://127.0.0.1:8000/api/health` |
| PowerShell блокирует скрипт | Используйте `scripts\dev.bat` или команду с `-ExecutionPolicy Bypass` выше |
| Антивирус ругается на venv/npm | Разрешите доступ для папки репозитория (локальная разработка) |
| Не вижу папку `.venv` | Она внутри `backend\` (`backend\.venv`), создаётся при первом запуске `dev.bat` |
| `python -m pytest` из корня: `No module named 'app'` | Используйте `scripts\checks.bat`, либо запустите из `backend\` интерпретатором `.venv\Scripts\python` (в системном Python могут отсутствовать fastapi/httpx) |
| `npm run ...`: `Could not read package.json` | Команды frontend выполняются из каталога `frontend\` (или используйте `scripts\checks.bat`) |

## Лицензия

[MIT](LICENSE)
