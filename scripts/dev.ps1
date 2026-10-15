#Requires -Version 5.1
<#
.SYNOPSIS
    Запуск Embedding Space Explorer: локальный backend (FastAPI) + frontend (Vite).

.DESCRIPTION
    Одна команда для старта всего приложения (TZ §2.1):
      1. Проверяет версии Python (3.11–3.13) и Node.js (>= 22.12).
      2. При первом запуске создаёт backend\.venv и устанавливает зависимости
         (pip install -r requirements*.txt, npm ci).
      3. Запускает backend и frontend в двух отдельных окнах cmd.
      4. Открывает http://localhost:5173 в браузере.

    Остановка: закрыть окна «ESE backend» и «ESE frontend» (или Ctrl+C в них).

.PARAMETER BackendPort
    Порт backend (по умолчанию 8000).

.PARAMETER FrontendPort
    Порт frontend (по умолчанию 5173).

.PARAMETER SkipInstall
    Пропустить установку зависимостей (если уже установлены).

.PARAMETER NoBrowser
    Не открывать браузер автоматически.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1
#>
[CmdletBinding()]
param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [switch]$SkipInstall,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "[ok] $Message" -ForegroundColor Green }
function Write-Bad([string]$Message)  { Write-Host "[ошибка] $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. Проверка окружения
# ---------------------------------------------------------------------------
function Get-PythonCandidate([string]$Exe, [string[]]$Prefix) {
    try {
        $verOut = & $Exe @Prefix -c "import sys; print('.'.join(str(v) for v in sys.version_info[:3]))" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $verOut) { return $null }
        $parts = "$verOut".Trim().Split('.')
        if ($parts.Count -lt 2) { return $null }
        $major = [int]$parts[0]; $minor = [int]$parts[1]
        if ($major -ne 3 -or $minor -lt 11 -or $minor -gt 13) { return $null }
        return [pscustomobject]@{ Exe = $Exe; Prefix = $Prefix; Version = "$verOut".Trim() }
    } catch {
        return $null
    }
}

Write-Step "Проверка окружения"

$python = $null
foreach ($candidate in @(
        @{ Exe = "py"; Prefix = @("-3.12") },
        @{ Exe = "py"; Prefix = @("-3.11") },
        @{ Exe = "py"; Prefix = @("-3.13") },
        @{ Exe = "python"; Prefix = @() }
    )) {
    $python = Get-PythonCandidate $candidate.Exe $candidate.Prefix
    if ($python) { break }
}
if (-not $python) {
    Write-Bad "Не найден Python 3.11–3.13."
    Write-Host "Установите Python 3.12 с https://www.python.org/downloads/ (при установке отметьте 'Add python.exe to PATH') и повторите запуск."
    exit 1
}
Write-Ok "Python $($python.Version) ($($python.Exe) $($python.Prefix -join ' '))"

try {
    $nodeVerRaw = & node --version 2>$null
} catch {
    $nodeVerRaw = $null
}
if (-not $nodeVerRaw) {
    Write-Bad "Не найден Node.js."
    Write-Host "Установите Node.js LTS (>= 22.12) с https://nodejs.org/ и повторите запуск."
    exit 1
}
$nodeMajor = [int]("$nodeVerRaw".TrimStart('v').Split('.')[0])
$nodeMinor = [int]("$nodeVerRaw".TrimStart('v').Split('.')[1])
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
    Write-Bad "Node.js $nodeVerRaw слишком старый; требуется >= 22.12 (инструменты разработки, vitest)."
    Write-Host "Обновите Node.js: https://nodejs.org/"
    exit 1
}
Write-Ok "Node.js $nodeVerRaw"

# ---------------------------------------------------------------------------
# 2. Зависимости
# ---------------------------------------------------------------------------
$backendDir = Join-Path $RepoRoot "backend"
$frontendDir = Join-Path $RepoRoot "frontend"
$venvPython = Join-Path $backendDir ".venv\Scripts\python.exe"

if (-not $SkipInstall) {
    if (-not (Test-Path $venvPython)) {
        Write-Step "Создание виртуального окружения backend\.venv"
        & $python.Exe @($python.Prefix) -m venv (Join-Path $backendDir ".venv")
        if ($LASTEXITCODE -ne 0) { Write-Bad "Не удалось создать venv"; exit 1 }
    }

    Write-Step "Установка зависимостей backend (pip) — при первом запуске может занять пару минут"
    & $venvPython -m pip install --disable-pip-version-check --quiet `
        -r (Join-Path $backendDir "requirements.txt") `
        -r (Join-Path $backendDir "requirements-dev.txt")
    if ($LASTEXITCODE -ne 0) { Write-Bad "pip install завершился с ошибкой"; exit 1 }
    Write-Ok "Зависимости backend установлены"

    Write-Step "Установка зависимостей frontend (npm ci) — при первом запуске может занять пару минут"
    Push-Location $frontendDir
    try {
        if (Test-Path "package-lock.json") {
            & npm ci --no-audit --no-fund
        } else {
            & npm install --no-audit --no-fund
        }
        if ($LASTEXITCODE -ne 0) { Write-Bad "npm install завершился с ошибкой"; exit 1 }
    } finally {
        Pop-Location
    }
    Write-Ok "Зависимости frontend установлены"
} elseif (-not (Test-Path $venvPython)) {
    Write-Bad "-SkipInstall указан, но backend\.venv не существует. Запустите без -SkipInstall."
    exit 1
}

# ---------------------------------------------------------------------------
# 3. Запуск backend и frontend
# ---------------------------------------------------------------------------
Write-Step "Запуск backend (окно 'ESE backend', http://127.0.0.1:$BackendPort)"
$backendCmd = "title ESE backend && cd /d `"$backendDir`" && `"$venvPython`" -m uvicorn app.main:app --host 127.0.0.1 --port $BackendPort"
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $backendCmd | Out-Null

Write-Step "Запуск frontend (окно 'ESE frontend', http://localhost:$FrontendPort)"
$frontendCmd = "title ESE frontend && cd /d `"$frontendDir`" && set ESE_BACKEND_URL=http://127.0.0.1:$BackendPort&& npm run dev -- --port $FrontendPort"
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $frontendCmd | Out-Null

Write-Host ""
Write-Ok "Приложение запускается."
Write-Host "    Интерфейс:   http://localhost:$FrontendPort"
Write-Host "    Backend API: http://127.0.0.1:$BackendPort/api/health"
Write-Host "    Swagger:     http://127.0.0.1:$BackendPort/api/docs"
Write-Host ""
Write-Host "Остановка: закройте окна 'ESE backend' и 'ESE frontend'." -ForegroundColor Yellow

if (-not $NoBrowser) {
    Start-Sleep -Seconds 4
    Start-Process "http://localhost:$FrontendPort"
}
