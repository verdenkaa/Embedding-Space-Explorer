#!/usr/bin/env bash
# Запуск Embedding Space Explorer одной командой (Linux/macOS).
# На Windows используйте scripts\dev.bat / dev.ps1.
#
# Использование: ./scripts/dev.sh [backend_port] [frontend_port]
set -euo pipefail

BACKEND_PORT="${1:-8000}"
FRONTEND_PORT="${2:-5173}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
VENV_PY="$BACKEND_DIR/.venv/bin/python"

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m[ok] %s\033[0m\n' "$1"; }
bad()  { printf '\033[31m[ошибка] %s\033[0m\n' "$1"; }

# --- 1. Проверка окружения ---------------------------------------------------
step "Проверка окружения"
PYTHON_BIN=""
for candidate in python3.12 python3.11 python3.13 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        if "$candidate" -c 'import sys; sys.exit(0 if (3,11) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then
            PYTHON_BIN="$candidate"
            break
        fi
    fi
done
if [ -z "$PYTHON_BIN" ]; then
    bad "Не найден Python 3.11–3.13. Установите его и повторите запуск."
    exit 1
fi
ok "Python $("$PYTHON_BIN" --version 2>&1) ($PYTHON_BIN)"

if ! command -v node >/dev/null 2>&1; then
    bad "Не найден Node.js. Установите Node.js >= 22.12: https://nodejs.org/"
    exit 1
fi
NODE_MAJOR="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
NODE_MINOR="$(node --version | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    bad "Node.js $(node --version) слишком старый; требуется >= 22.12."
    exit 1
fi
ok "Node.js $(node --version)"

# --- 2. Зависимости ----------------------------------------------------------
# Установка выполняется только когда она действительно нужна:
# - pip: stamp-файл .venv/.ese-deps.stamp старше requirements*.txt И ключевые
#   пакеты импортируются;
# - npm: node_modules на месте И package-lock.json не новее маркера
#   node_modules/.package-lock.json (npm ci каждый запуск стирал бы
#   node_modules и переустанавливал всё заново — долгие старты, нагрузка на ПК).
# Принудительная переустановка: FORCE_INSTALL=1 ./scripts/dev.sh
if [ ! -x "$VENV_PY" ]; then
    step "Создание виртуального окружения backend/.venv"
    "$PYTHON_BIN" -m venv "$BACKEND_DIR/.venv"
fi

DEPS_STAMP="$BACKEND_DIR/.venv/.ese-deps.stamp"
NPM_MARKER="$FRONTEND_DIR/node_modules/.package-lock.json"

need_pip=1
if [ "${FORCE_INSTALL:-0}" != "1" ] && [ -f "$DEPS_STAMP" ] \
    && [ ! "$BACKEND_DIR/requirements.txt" -nt "$DEPS_STAMP" ] \
    && [ ! "$BACKEND_DIR/requirements-dev.txt" -nt "$DEPS_STAMP" ] \
    && "$VENV_PY" -c 'import fastapi, uvicorn, sqlalchemy, numpy, sklearn, nbformat, jupyter_client, ipykernel' >/dev/null 2>&1; then
    need_pip=0
fi
if [ "${SKIP_INSTALL:-0}" != "1" ] && [ "$need_pip" = "1" ]; then
    step "Установка зависимостей backend (pip)"
    "$VENV_PY" -m pip install --disable-pip-version-check --quiet \
        -r "$BACKEND_DIR/requirements.txt" -r "$BACKEND_DIR/requirements-dev.txt"
    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$DEPS_STAMP"
    ok "Зависимости backend установлены"
elif [ "$need_pip" = "0" ]; then
    ok "Зависимости backend актуальны — pip install пропущен (FORCE_INSTALL=1 для переустановки)"
fi

need_npm=1
if [ "${FORCE_INSTALL:-0}" != "1" ] && [ -d "$FRONTEND_DIR/node_modules" ] && [ -f "$NPM_MARKER" ] \
    && [ ! "$FRONTEND_DIR/package-lock.json" -nt "$NPM_MARKER" ]; then
    need_npm=0
fi
if [ "${SKIP_INSTALL:-0}" != "1" ] && [ "$need_npm" = "1" ]; then
    step "Установка зависимостей frontend (npm)"
    (
        cd "$FRONTEND_DIR"
        if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
    )
    ok "Зависимости frontend установлены"
elif [ "$need_npm" = "0" ]; then
    ok "Зависимости frontend актуальны — npm ci пропущен (FORCE_INSTALL=1 для переустановки)"
fi

# --- 3. Запуск ----------------------------------------------------------------
BACKEND_PID=""
FRONTEND_PID=""
cleanup() {
    [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

step "Запуск backend: http://127.0.0.1:$BACKEND_PORT"
(
    cd "$BACKEND_DIR"
    exec "$VENV_PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$BACKEND_PORT"
) &
BACKEND_PID=$!

step "Запуск frontend: http://localhost:$FRONTEND_PORT"
(
    cd "$FRONTEND_DIR"
    export ESE_BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
    exec npm run dev -- --port "$FRONTEND_PORT" --strictPort
) &
FRONTEND_PID=$!

echo ""
ok "Приложение запускается."
echo "    Интерфейс:   http://localhost:$FRONTEND_PORT"
echo "    Backend API: http://127.0.0.1:$BACKEND_PORT/api/health"
echo "    Остановка:   Ctrl+C"
echo ""

wait
