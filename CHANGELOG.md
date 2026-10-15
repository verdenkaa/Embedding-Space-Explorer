# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект придерживается [семантического версионирования](https://semver.org/lang/ru/).

## [0.1.0] — 2026-10-15

Этап 0 — обследование среды и каркас приложения.

### Добавлено

- Структура монорепозитория: `backend/` (Python, FastAPI), `frontend/` (React, TypeScript, Vite),
  `docs/`, `scripts/`.
- Backend:
  - фабрика приложения `create_app()` с конфигурацией через переменные окружения (`ESE_HOST`,
    `ESE_PORT`, `ESE_DATA_DIR`, `ESE_FRONTEND_PORTS`);
  - эндпоинт диагностики `GET /api/health`: версия приложения и схемы данных, версия Python,
    платформа, каталог данных, статусы проверок, версии обязательных и запланированных
    зависимостей;
  - middleware `LocalOnlyMiddleware`: запросы принимаются только с loopback-`Host`
    (`127.0.0.1` / `localhost` / `::1`), изменяющие методы (POST/PUT/PATCH/DELETE) с
    нелокальным `Origin` отклоняются (защита от DNS rebinding / CSRF);
  - CORS разрешён только для локальных адресов фронтенда;
  - сервер по умолчанию слушает только `127.0.0.1:8000`;
  - тесты pytest (health + security), ruff, mypy (strict).
- Frontend:
  - каркас интерфейса в стиле «тёмная исследовательская IDE» (дизайн-токены по UI-ТЗ);
  - панель диагностики с состояниями загрузка / онлайн / офлайн и понятными подсказками;
  - типизированный API-клиент и zustand-store состояния подключения;
  - разделы SPACE / CORPUS / RELATIONS / EXPERIMENTS показаны как запланированные
    (видимая недоступность с указанием этапа, без «кнопок-обманок»);
  - vitest + @testing-library (тесты состояний панели и API-клиента), ESLint, tsc strict.
- Скрипты запуска одной командой: `scripts/dev.bat` и `scripts/dev.ps1` (Windows),
  `scripts/dev.sh` (Linux/macOS): проверка версий Python/Node, установка зависимостей,
  запуск backend и frontend.
- Документация: `README.md`, `docs/architecture.md`, `docs/development.md`.
- Зафиксированные версии зависимостей: `backend/requirements*.txt`,
  `frontend/package-lock.json`.

[0.1.0]: https://github.com/verdenkaa/Embedding-Space-Explorer/releases/tag/v0.1.0
