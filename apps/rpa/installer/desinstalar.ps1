# Desinstala el robot de este equipo. En el servidor, el robot sigue registrado:
# deshabilítelo desde el panel si este equipo deja de usarse.

$ErrorActionPreference = 'Stop'
$destino = $PSScriptRoot
# Detener el robot: Node de cualquier versión instalada y el lanzador (iniciar.ps1 / iniciar.cmd).
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -like "$destino\*") -or
    ($_.CommandLine -like "*$destino\iniciar.*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$acceso = Join-Path ([Environment]::GetFolderPath('Startup')) 'Robot Abaya.lnk'
if (Test-Path $acceso) { Remove-Item $acceso -Force }

# La carpeta se borra al salir (este script vive dentro de ella).
Start-Process -FilePath 'cmd.exe' -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$destino`"" -WindowStyle Hidden
Write-Host "Robot desinstalado de este equipo ($env:COMPUTERNAME)." -ForegroundColor Green
Write-Host 'Recuerde deshabilitarlo en el panel si este equipo deja de usarse.'
