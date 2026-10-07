@echo off
rem Instalador del robot de Abaya. Ver LEEME.txt.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
if errorlevel 1 (
  echo.
  echo La instalacion no se completo. Revise el mensaje anterior.
)
pause
