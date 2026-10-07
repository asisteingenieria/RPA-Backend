@echo off
rem Pide al robot en marcha que busque la version publicada en el servidor (v1.7).
rem El robot verifica la firma, la prepara y la activa cuando termine sus chats.
echo si> "%~dp0solicitar-actualizacion.txt"
echo.
echo Solicitud enviada. El robot buscara la version publicada en el servidor,
echo verificara su firma y se actualizara cuando no tenga chats abiertos.
echo El avance se ve en el panel (pestana Robots).
echo.
pause
