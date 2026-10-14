@echo off
rem Diagnostico de Abaya por pasos (D-020). Uso: probar.cmd ^<paso^> [--ver]
rem Pasos: url, login, estado, disponible, bandeja. La logica vive en probar.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0probar.ps1" %*
