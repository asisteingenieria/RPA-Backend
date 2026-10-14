# Diagnóstico de Abaya por pasos (D-020, docs/runbook.md 8.e).
#
#   probar.cmd <paso> [--ver]     pasos: url, login, estado, disponible, bandeja
#
# Usa la versión vigente del robot y las credenciales que entrega el servidor (como el robot).
# El robot debe estar DETENIDO (cerrar la ventana "Robot Abaya"): un robot, un equipo a la vez.

$raiz = $PSScriptRoot
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $raiz 'navegador'
$env:ROBOT_AGENT_FILE = Join-Path $raiz 'robot.json'
$env:ROBOT_INSTALL_DIR = $raiz
$envLocal = Join-Path $raiz 'robot.local.env'

$actual = Join-Path $raiz 'current.txt'
$version = if (Test-Path $actual) { (Get-Content $actual -Raw).Trim() } else { $null }
$dir = if ($version) { Join-Path $raiz "versions\$version" } else { $raiz }
$node = Join-Path $dir 'node\node.exe'
$script = Join-Path $dir 'app\dist\cli\probar-abaya.js'
if (-not (Test-Path $node) -or -not (Test-Path $script)) {
  Write-Host 'Esta versión del robot no trae el diagnóstico. Actualice el robot (actualizar.cmd).'
  exit 1
}
& $node "--env-file-if-exists=$envLocal" $script @args
exit $LASTEXITCODE
