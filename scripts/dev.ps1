#Requires -Version 5.1
<#
.SYNOPSIS
    Запуск Embedding Space Explorer: локальный backend (FastAPI) + frontend (Vite).

.DESCRIPTION
    Одна команда для старта всего приложения:
      1. Проверяет версии Python (3.11-3.13) и Node.js (>= 22.12).
      2. При первом запуске создаёт backend\.venv и устанавливает зависимости
         (pip install -r requirements*.txt, npm ci). При повторных запусках
         установка ПРОПУСКАЕТСЯ, если lock-файлы не менялись: pip сверяется
         со stamp-файлом .venv\.ese-deps.stamp, npm ci выполняется только
         когда package-lock.json новее node_modules\.package-lock.json
         (npm ci каждый запуск стирал бы node_modules и переустанавливал
         всё заново - отсюда долгие старты и нагрузка на диск).
      3. Запускает backend и frontend в двух отдельных окнах PowerShell.
      4. Ждёт ответа backend и открывает http://localhost:5173 в браузере.

    Остановка: закрыть окна 'ESE backend' и 'ESE frontend' (или Ctrl+C в них).

.PARAMETER BackendPort
    Порт backend (по умолчанию 8000).

.PARAMETER FrontendPort
    Порт frontend (по умолчанию 5173).

.PARAMETER SkipInstall
    Пропустить установку зависимостей (если уже установлены).

.PARAMETER ForceInstall
    Принудительно переустановить зависимости (игнорируя проверку актуальности).

.PARAMETER NoBrowser
    Не открывать браузер автоматически.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev.ps1

.NOTES
    Совместимость: Windows PowerShell 5.1+ и PowerShell 7+.
    ВАЖНО: файл должен сохраняться в UTF-8 with BOM, иначе Windows PowerShell
    5.1 неверно прочитает кириллицу. Использовать только ASCII-пунктуацию
    (обычные кавычки " и ', дефис -): "умные" кавычки и тире ломают разбор.
#>
[CmdletBinding()]
param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [switch]$SkipInstall,
    [switch]$ForceInstall,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "[ok] $Message" -ForegroundColor Green }
function Write-Bad([string]$Message)  { Write-Host "[ошибка] $Message" -ForegroundColor Red }

function Format-SingleQuoted([string]$Value) {
    # Экранирование строки для встраивания в одинарные кавычки PowerShell.
    return "'" + $Value.Replace("'", "''") + "'"
}

# ---------------------------------------------------------------------------
# 1. Проверка окружения
# ---------------------------------------------------------------------------
function Get-PythonCandidate([string]$Exe, [string[]]$Prefix) {
    try {
        $verOut = & $Exe @Prefix -c "import sys; print('.'.join(str(v) for v in sys.version_info[:3]))" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $verOut) { return $null }
        $parts = "$verOut".Trim().Split('.')
        if ($parts.Count -lt 2) { return $null }
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
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
    Write-Bad "Не найден Python 3.11-3.13."
    Write-Host "Установите Python 3.12 с https://www.python.org/downloads/ (при установке отметьте 'Add python.exe to PATH') и повторите запуск."
    exit 1
}
$pythonArgs = ($python.Prefix -join ' ')
Write-Ok "Python $($python.Version) ($($python.Exe) $pythonArgs)"

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
$venvPython = "$backendDir\.venv\Scripts\python.exe"

if (-not $SkipInstall) {
    if (-not (Test-Path $venvPython)) {
        Write-Step "Создание виртуального окружения backend\.venv"
        & $python.Exe @($python.Prefix) -m venv "$backendDir\.venv"
        if ($LASTEXITCODE -ne 0) { Write-Bad "Не удалось создать venv"; exit 1 }
    }

    # --- backend (pip): установка только когда requirements новее stamp-файла
    # или ключевые пакеты не импортируются (повреждённое окружение).
    $depsStamp = "$backendDir\.venv\.ese-deps.stamp"
    $needPip = [bool]$ForceInstall -or -not (Test-Path $depsStamp)
    if (-not $needPip) {
        $stampTime = (Get-Item $depsStamp).LastWriteTime
        foreach ($reqName in @("requirements.txt", "requirements-dev.txt")) {
            $reqPath = Join-Path $backendDir $reqName
            if ((Test-Path $reqPath) -and ((Get-Item $reqPath).LastWriteTime -gt $stampTime)) {
                $needPip = $true
            }
        }
    }
    if (-not $needPip) {
        & $venvPython -c "import fastapi, uvicorn, sqlalchemy, numpy, sklearn, nbformat, jupyter_client, ipykernel" 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $needPip = $true }
    }
    if ($needPip) {
        Write-Step "Установка зависимостей backend (pip) - при первом запуске может занять пару минут"
        & $venvPython -m pip install --disable-pip-version-check --quiet -r (Join-Path $backendDir "requirements.txt") -r (Join-Path $backendDir "requirements-dev.txt")
        if ($LASTEXITCODE -ne 0) { Write-Bad "pip install завершился с ошибкой"; exit 1 }
        Set-Content -Path $depsStamp -Value (Get-Date -Format o) -Encoding ASCII
        Write-Ok "Зависимости backend установлены"
    } else {
        Write-Ok "Зависимости backend актуальны - pip install пропущен (-ForceInstall для переустановки)"
    }

    # --- frontend (npm): npm ci ПОЛНОСТЬЮ стирает node_modules, поэтому
    # запускаем его только когда node_modules нет или package-lock.json
    # новее маркера node_modules\.package-lock.json (который npm ci создаёт).
    $nodeModules = Join-Path $frontendDir "node_modules"
    $npmMarker = Join-Path $nodeModules ".package-lock.json"
    $lockPath = Join-Path $frontendDir "package-lock.json"
    $needNpm = [bool]$ForceInstall -or -not (Test-Path $nodeModules) -or -not (Test-Path $npmMarker)
    if ((-not $needNpm) -and (Test-Path $lockPath) -and
        ((Get-Item $lockPath).LastWriteTime -gt (Get-Item $npmMarker).LastWriteTime)) {
        $needNpm = $true
    }
    if ($needNpm) {
        Write-Step "Установка зависимостей frontend (npm ci) - при первом запуске может занять пару минут"
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
    } else {
        Write-Ok "Зависимости frontend актуальны - npm ci пропущен (-ForceInstall для переустановки)"
    }
} elseif (-not (Test-Path $venvPython)) {
    Write-Bad "-SkipInstall указан, но backend\.venv не существует. Запустите сначала без -SkipInstall."
    exit 1
}

# ---------------------------------------------------------------------------
# 3. Запуск backend и frontend (отдельные окна PowerShell)
# ---------------------------------------------------------------------------
# Примечание: команды для дочерних окон собираются как одна строка с ';' -
# оператор '&&' недоступен в Windows PowerShell 5.1.
$backendChildCmd = "`$Host.UI.RawUI.WindowTitle = 'ESE backend'; Set-Location $(Format-SingleQuoted $backendDir); & $(Format-SingleQuoted $venvPython) -m uvicorn app.main:app --host 127.0.0.1 --port $BackendPort"
$frontendChildCmd = "`$Host.UI.RawUI.WindowTitle = 'ESE frontend'; Set-Location $(Format-SingleQuoted $frontendDir); `$env:ESE_BACKEND_URL = 'http://127.0.0.1:$BackendPort'; npm run dev -- --port $FrontendPort"

Write-Step "Запуск backend (окно 'ESE backend', http://127.0.0.1:$BackendPort)"
Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile', '-NoExit', '-Command', $backendChildCmd)

Write-Step "Запуск frontend (окно 'ESE frontend', http://localhost:$FrontendPort)"
Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile', '-NoExit', '-Command', $frontendChildCmd)

# ---------------------------------------------------------------------------
# 4. Ожидание backend и открытие браузера
# ---------------------------------------------------------------------------
Write-Step "Ожидание старта backend (до 25 секунд)..."
$deadline = (Get-Date).AddSeconds(25)
$backendReady = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    try {
        $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$BackendPort/api/health" -UseBasicParsing -TimeoutSec 2
        if ($probe.StatusCode -eq 200) { $backendReady = $true; break }
    } catch {
        # backend ещё не поднялся - продолжаем ждать
    }
}

if ($backendReady) {
    Write-Ok "backend отвечает: http://127.0.0.1:$BackendPort/api/health"
} else {
    Write-Bad "backend не ответил за 25 секунд. Смотрите окно 'ESE backend'."
    Write-Host "Частые причины: занят порт $BackendPort (тогда запустите с -BackendPort 8001), ошибка установки зависимостей, блокировка антивирусом."
}

Write-Host ""
Write-Ok "Приложение запускается."
Write-Host "    Интерфейс:   http://localhost:$FrontendPort"
Write-Host "    Backend API: http://127.0.0.1:$BackendPort/api/health"
Write-Host "    Swagger:     http://127.0.0.1:$BackendPort/api/docs"
Write-Host ""
Write-Host "Остановка: закройте окна 'ESE backend' и 'ESE frontend'." -ForegroundColor Yellow

if (-not $NoBrowser) {
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:$FrontendPort"
}
