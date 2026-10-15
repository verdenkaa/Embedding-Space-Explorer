@echo off
rem Runs the full test/lint/typecheck/build suite for backend and frontend
rem using the project's own environments (backend\.venv, frontend\node_modules).
rem Can be launched from any directory. Usage: scripts\checks.bat [-BackendOnly|-FrontendOnly]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0checks.ps1" %*
