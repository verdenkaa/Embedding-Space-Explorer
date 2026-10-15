@echo off
rem Embedding Space Explorer launcher (Windows).
rem Bypasses ExecutionPolicy for this process only.
rem Usage: scripts\dev.bat  (optional args are passed to dev.ps1, e.g. -BackendPort 8001)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
