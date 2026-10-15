@echo off
rem Запуск Embedding Space Explorer одной командой (двойной клик или из консоли).
rem Обходит ограничение ExecutionPolicy для текущего процесса PowerShell.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev.ps1" %*
