# Lanzador del robot hijo de Abaya (v1.7, sección 2.9 de docs/planRPA.md).
#
# - Arranca la versión vigente (versions\<versión>, indicada en current.txt).
# - Si el robot se cae, lo reinicia a los 30 s.
# - Código 3: el servidor rechazó este equipo (deshabilitado, duplicado, revocado): no reintenta.
# - Código 4: hay una versión nueva preparada (pending.txt): la activa "a prueba".
# - Si la versión a prueba se cae dos veces en sus primeros 2 minutos, vuelve a la anterior
#   (rollback.txt) y el robot lo informa al servidor.

$ErrorActionPreference = 'Continue'
$raiz = $PSScriptRoot
try { $Host.UI.RawUI.WindowTitle = 'Robot Abaya' } catch { }
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $raiz 'navegador'
$env:ROBOT_AGENT_FILE = Join-Path $raiz 'robot.json'
$env:ROBOT_INSTALL_DIR = $raiz
$envLocal = Join-Path $raiz 'robot.local.env'

function Leer([string]$nombre) {
  $p = Join-Path $raiz $nombre
  if (Test-Path $p) { return (Get-Content $p -Raw).Trim() }
  return $null
}
function Escribir([string]$nombre, [string]$valor) {
  Set-Content -Path (Join-Path $raiz $nombre) -Value $valor -Encoding ASCII
}
function Borrar([string]$nombre) {
  Remove-Item (Join-Path $raiz $nombre) -Force -ErrorAction SilentlyContinue
}
function Log([string]$texto) { Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $texto" }

function Revertir([string]$version) {
  $anterior = Leer 'previous.txt'
  if (-not $anterior) { return $false }
  Log "La versión $version no arranca: se vuelve a $anterior."
  Escribir 'current.txt' $anterior
  Escribir 'rollback.txt' $version
  Borrar 'probation.txt'
  return $true
}

$fallasAPrueba = 0
while ($true) {
  $version = Leer 'current.txt'
  # Instalaciones anteriores a v1.7 (sin versiones): app\ y node\ en la raíz.
  $dir = if ($version) { Join-Path $raiz "versions\$version" } else { $raiz }
  $node = Join-Path $dir 'node\node.exe'
  $main = Join-Path $dir 'app\dist\main.js'
  if (-not (Test-Path $node) -or -not (Test-Path $main)) {
    if ((Leer 'probation.txt') -and (Revertir $version)) { continue }
    Log "No se encuentra la versión '$version' del robot. Reinstale el robot."
    Read-Host 'Presione Enter para cerrar' | Out-Null
    exit 1
  }

  Log "Iniciando el robot (versión $(if ($version) { $version } else { 'instalación anterior' }))..."
  $inicio = Get-Date
  & $node "--env-file-if-exists=$envLocal" $main
  $codigo = $LASTEXITCODE
  $segundos = ((Get-Date) - $inicio).TotalSeconds

  if ($codigo -eq 0) { exit 0 }
  if ($codigo -eq 3) {
    Write-Host ''
    Write-Host 'El servidor indicó que este equipo no debe ejecutar el robot:'
    Write-Host '  - el robot está deshabilitado, o'
    Write-Host '  - ya está en línea en otro equipo, o'
    Write-Host '  - la instalación fue revocada.'
    Write-Host 'Revise la pestaña Robots del panel. Si hace falta, genere un código nuevo y reinstale.'
    Read-Host 'Presione Enter para cerrar' | Out-Null
    exit 3
  }
  if ($codigo -eq 4) {
    $nueva = Leer 'pending.txt'
    if ($nueva -and (Test-Path (Join-Path $raiz "versions\$nueva\app\dist\main.js"))) {
      if ($version) { Escribir 'previous.txt' $version }
      Escribir 'current.txt' $nueva
      Escribir 'probation.txt' $nueva
      Borrar 'pending.txt'
      $fallasAPrueba = 0
      Log "Activando la versión $nueva (a prueba)."
      continue
    }
    Log 'Se pidió activar una versión nueva pero no está preparada; se sigue con la actual.'
    Borrar 'pending.txt'
    continue
  }

  # Caída. Una versión a prueba que no aguanta 2 minutos, dos veces, se revierte.
  if ((Leer 'probation.txt') -and $segundos -lt 120) {
    $fallasAPrueba++
    if ($fallasAPrueba -ge 2 -and (Revertir $version)) { $fallasAPrueba = 0; continue }
    Log "La versión nueva se detuvo (código $codigo). Reintento en 5 segundos..."
    Start-Sleep -Seconds 5
    continue
  }
  Log "El robot se detuvo (código $codigo). Reintento en 30 segundos..."
  Start-Sleep -Seconds 30
}
