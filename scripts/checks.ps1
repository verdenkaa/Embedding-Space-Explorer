#Requires -Version 5.1
<#
.SYNOPSIS
    Полный набор проверок Embedding Space Explorer (backend + frontend).

.DESCRIPTION
    Запускает все проверки проекта в его собственных окружениях:
      backend  : pytest, ruff check, ruff format --check, mypy  (backend\.venv)
      frontend : vitest, eslint, tsc --noEmit, vite build       (frontend\node_modules)

    Можно запускать из любого каталога. Если окружения не установлены,
    сначала запустите scripts\dev.bat (он создаст backend\.venv и
    frontend\node_modules).

.PARAMETER BackendOnly
    Запустить только проверки backend.

.PARAMETER FrontendOnly
    Запустить только проверки frontend.

.EXAMPLE
    scripts\checks.bat
#>
[CmdletBinding()]
param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly
)

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Results = @()

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host "[ok] $Message" -ForegroundColor Green }
function Write-Bad([string]$Message)  { Write-Host "[провал] $Message" -ForegroundColor Red }

function Invoke-Check {
    param(
        [string]$Name,
        [scriptblock]$Block,
        [string]$WorkDir
    )
    Write-Step "$Name  ($WorkDir\)"
    $code = 1
    Push-Location (Join-Path $RepoRoot $WorkDir)
    try {
        & $Block
        if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
    } catch {
        Write-Bad "$Name : $($_.Exception.Message)"
        $code = 1
    } finally {
        Pop-Location
    }
    if ($code -eq 0) {
        Write-Ok $Name
        $script:Results += [pscustomobject]@{ Check = $Name; Result = "PASS" }
    } else {
        Write-Bad "$Name (код выхода $code)"
        $script:Results += [pscustomobject]@{ Check = $Name; Result = "FAIL" }
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
if (-not $FrontendOnly) {
    $venvPython = "$RepoRoot\backend\.venv\Scripts\python.exe"
    if (-not (Test-Path $venvPython)) {
        Write-Bad "backend\.venv не найдена. Сначала запустите scripts\dev.bat (он установит зависимости)."
        $script:Results += [pscustomobject]@{ Check = "backend venv"; Result = "FAIL" }
    } else {
        Invoke-Check "pytest" { & $venvPython -m pytest } "backend"
        Invoke-Check "ruff check" { & $venvPython -m ruff check . } "backend"
        Invoke-Check "ruff format" { & $venvPython -m ruff format --check . } "backend"
        Invoke-Check "mypy (strict)" { & $venvPython -m mypy . } "backend"
    }
}

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
if (-not $BackendOnly) {
    if (-not (Test-Path "$RepoRoot\frontend\node_modules")) {
        Write-Bad "frontend\node_modules не найдены. Сначала запустите scripts\dev.bat (он выполнит npm ci)."
        $script:Results += [pscustomobject]@{ Check = "frontend node_modules"; Result = "FAIL" }
    } else {
        Invoke-Check "vitest" { npm run test } "frontend"
        Invoke-Check "eslint" { npm run lint } "frontend"
        Invoke-Check "tsc (strict)" { npm run typecheck } "frontend"
        Invoke-Check "vite build" { npm run build } "frontend"
    }
}

# ---------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------
Write-Host "Итоги:" -ForegroundColor Cyan
$script:Results | Format-Table -Property @{ L = "Проверка"; E = { $_.Check } }, @{ L = "Результат"; E = { $_.Result } } -AutoSize | Out-String | Write-Host

$failed = @($script:Results | Where-Object { $_.Result -eq "FAIL" })
if ($failed.Count -gt 0) {
    Write-Bad "Провалено проверок: $($failed.Count)"
    exit 1
}
Write-Ok "Все проверки пройдены"
exit 0
