@echo off
rem Consola en UTF-8: los logs del robot traen tildes.
chcp 65001 >nul
rem Lanzador del robot de Abaya (v1.7): la logica vive en iniciar.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar.ps1"
