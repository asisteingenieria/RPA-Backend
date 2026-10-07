# Instalador del robot hijo de Abaya (v1.4 y v1.7, secciones 2.6 y 2.9 de docs/planRPA.md).
#
# Pide solo la URL del servidor y el código de instalación generado en el panel.
# No pide ni guarda la contraseña de Abaya: el equipo la recibe del servidor al arrancar.
# Instala en versiones lado a lado (versions\<versión>) para poder actualizar y revertir.
#
#   instalar.cmd                                   (pregunta los datos)
#   instalar.cmd -Servidor https://rpa.empresa -Codigo ABCD-EFGH-JKLM [-SinVentana] [-NoIniciar]

param(
  [string]$Servidor,
  [string]$Codigo,
  [string]$Destino = (Join-Path $env:LOCALAPPDATA 'AbayaRobot'),
  [int]$Puerto = 3001,
  [switch]$SinVentana,
  [switch]$NoIniciar,
  [switch]$SinArranqueAutomatico,
  [switch]$PermitirHttp
)

$ErrorActionPreference = 'Stop'
$origen = $PSScriptRoot

function Paso($texto) { Write-Host "`n==> $texto" -ForegroundColor Cyan }

Write-Host 'Instalación del robot de ventas de Abaya' -ForegroundColor Green
if (-not $Servidor) { $Servidor = Read-Host 'Dirección del servidor (por ejemplo https://rpa.empresa.com)' }
if (-not $Codigo) { $Codigo = Read-Host 'Código de instalación (lo da el panel, por ejemplo ABCD-EFGH-JKLM)' }
$Servidor = $Servidor.Trim()
$Codigo = $Codigo.Trim()

# Versión del paquete (misma regla de nombre de carpeta que usa el robot al actualizarse).
$version = (Get-Content (Join-Path $origen 'app\package.json') -Raw | ConvertFrom-Json).version
$carpetaVersion = ($version -replace '[^\w.+-]', '_')
if ($carpetaVersion.Length -gt 64) { $carpetaVersion = $carpetaVersion.Substring(0, 64) }
$dirVersion = Join-Path $Destino "versions\$carpetaVersion"

# Si ya hay un robot corriendo desde esta carpeta, se detiene para poder reemplazar archivos.
$destinoCompleto = [IO.Path]::GetFullPath($Destino)
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -like "$destinoCompleto\*") -or
    ($_.Name -match '^powershell' -and $_.CommandLine -like "*$destinoCompleto\iniciar.ps1*")
  } |
  ForEach-Object { Paso 'Deteniendo el robot anterior'; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Paso "Copiando la versión $version a $dirVersion"
New-Item -ItemType Directory -Force -Path $dirVersion | Out-Null
foreach ($carpeta in 'app', 'node') {
  robocopy (Join-Path $origen $carpeta) (Join-Path $dirVersion $carpeta) /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "No se pudo copiar $carpeta (robocopy $LASTEXITCODE)" }
}
foreach ($archivo in 'iniciar.cmd', 'iniciar.ps1', 'actualizar.cmd', 'desinstalar.ps1', 'desinstalar.cmd', 'LEEME.txt', 'VERSION') {
  Copy-Item (Join-Path $origen $archivo) $Destino -Force
}
Set-Content -Path (Join-Path $Destino 'current.txt') -Value $carpetaVersion -Encoding ASCII
foreach ($f in 'pending.txt', 'probation.txt', 'rollback.txt', 'previous.txt') {
  Remove-Item (Join-Path $Destino $f) -Force -ErrorAction SilentlyContinue
}
# Instalaciones anteriores a v1.7 (app\ y node\ en la raíz): ya no se usan.
foreach ($viejo in 'app', 'node') {
  $p = Join-Path $Destino $viejo
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}
$node = Join-Path $dirVersion 'node\node.exe'

Paso 'Instalando el navegador del robot (Chromium)'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $Destino 'navegador'
$navegadorIncluido = Join-Path $origen 'navegador'
if (Test-Path $navegadorIncluido) {
  robocopy $navegadorIncluido $env:PLAYWRIGHT_BROWSERS_PATH /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "No se pudo copiar el navegador (robocopy $LASTEXITCODE)" }
} else {
  & $node (Join-Path $dirVersion 'app\node_modules\playwright\cli.js') install chromium
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo descargar el navegador (revise la conexión a Internet o use un paquete con navegador incluido)' }
}

Paso 'Registrando este equipo en el servidor'
$robotJson = Join-Path $Destino 'robot.json'
$enrollArgs = @((Join-Path $dirVersion 'app\dist\cli\enroll.js'), '--servidor', $Servidor, '--codigo', $Codigo, '--archivo', $robotJson)
if ($PermitirHttp) { $enrollArgs += '--permitir-http' }
& $node @enrollArgs
if ($LASTEXITCODE -ne 0) { throw 'El servidor no aceptó el código. Genere uno nuevo en el panel (pestaña Robots).' }

# Solo configuración local del equipo; nada secreto.
$datos = Join-Path $Destino 'datos'
New-Item -ItemType Directory -Force -Path $datos | Out-Null
@(
  "ABAYA_HEADLESS=$(if ($SinVentana) { 'true' } else { 'false' })",
  "RPA_PORT=$Puerto",
  "SESSION_STATE_DIR=$datos",
  "TRACE_DIR=$(Join-Path $datos 'trazas')"
) | Set-Content -Path (Join-Path $Destino 'robot.local.env') -Encoding ASCII

# Solo el usuario de Windows que instaló (y SYSTEM) puede leer la carpeta: token del equipo y
# sesión cifrada. Se aplica en la raíz y el contenido lo hereda (sin /T: evita rutas largas).
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $Destino /grant:r "*$($sid):(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudieron asignar permisos a $Destino (icacls $LASTEXITCODE)" }
icacls $Destino /inheritance:r /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "No se pudo proteger $Destino (icacls $LASTEXITCODE)" }

if (-not $SinArranqueAutomatico) {
  Paso 'Configurando el arranque automático al iniciar sesión en Windows'
  $inicio = [Environment]::GetFolderPath('Startup')
  $acceso = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $inicio 'Robot Abaya.lnk'))
  $acceso.TargetPath = Join-Path $Destino 'iniciar.cmd'
  $acceso.WorkingDirectory = $Destino
  $acceso.WindowStyle = 7  # minimizado
  $acceso.Description = 'Robot de ventas de Abaya'
  $acceso.Save()
}

# ---------- Preparación del equipo (v1.7): solo revisa y avisa; no cambia nada ----------
Paso 'Revisando la preparación del equipo'
$revision = @()
function Revisar([string]$tema, [bool]$ok, [string]$consejo) {
  $marca = if ($ok) { '[OK]   ' } else { '[AVISO]' }
  $linea = "$marca $tema" + $(if ($ok) { '' } else { " -> $consejo" })
  Write-Host $linea -ForegroundColor $(if ($ok) { 'Green' } else { 'Yellow' })
  $script:revision += $linea
}
try {
  # Suspensión con corriente (AC): 0 = nunca.
  $susp = powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null |
    Select-String 'Corriente alterna|AC Power Setting Index' | Select-Object -First 1
  $valor = if ($susp) { [Convert]::ToInt32(($susp.ToString() -split '0x')[-1].Trim(), 16) } else { -1 }
  Revisar 'El equipo no entra en suspensión' ($valor -eq 0) 'Configurar "Suspender: Nunca" con corriente (Configuración > Energía)'
} catch { Revisar 'El equipo no entra en suspensión' $false 'No se pudo leer; revisar en Configuración > Energía' }
try {
  $wu = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' -ErrorAction Stop
  $definidas = ($null -ne $wu.ActiveHoursStart) -and ($null -ne $wu.ActiveHoursEnd)
  Revisar "Horas activas de Windows Update definidas ($($wu.ActiveHoursStart)-$($wu.ActiveHoursEnd) h)" $definidas 'Definir horas activas que cubran el horario de atención (no reiniciará en ese horario)'
} catch { Revisar 'Horas activas de Windows Update' $false 'Definirlas para que no reinicie en horario de atención (TI)' }
try {
  $wl = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction Stop
  Revisar 'Inicio de sesión automático del usuario del robot' ($wl.AutoAdminLogon -eq '1') 'Pedir a TI inicio de sesión automático para este usuario (el robot corre en su sesión)'
} catch { Revisar 'Inicio de sesión automático' $false 'Pedir a TI que lo configure' }
$libreGB = [math]::Round((Get-PSDrive ([IO.Path]::GetPathRoot($destinoCompleto).Substring(0, 1))).Free / 1GB, 1)
Revisar "Espacio libre en disco: $libreGB GB" ($libreGB -ge 5) 'Liberar espacio: las actualizaciones necesitan unos 2 GB'
Revisar 'Excepción del antivirus para la carpeta del robot' $false "Pedir a TI una excepción para $destinoCompleto (recordatorio: no se puede verificar)"
$revision | Set-Content -Path (Join-Path $Destino 'preparacion.txt') -Encoding UTF8

if (-not $NoIniciar) {
  Paso 'Iniciando el robot'
  Start-Process -FilePath (Join-Path $Destino 'iniciar.cmd') -WorkingDirectory $Destino -WindowStyle Minimized
}

$robot = (Get-Content $robotJson -Raw | ConvertFrom-Json).robotUser
Write-Host "`nListo. Este equipo ($env:COMPUTERNAME) quedó registrado como $robot (versión $version)." -ForegroundColor Green
Write-Host 'En el panel (pestaña Robots) debe aparecer En línea en menos de un minuto.'
Write-Host "Revisión del equipo guardada en $Destino\preparacion.txt"
Write-Host "Para detenerlo: cierre la ventana 'Robot Abaya'. Para desinstalar: $Destino\desinstalar.cmd"
