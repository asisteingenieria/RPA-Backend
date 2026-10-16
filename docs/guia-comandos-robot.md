# Guía de comandos del robot de ventas (Abaya / ySocial)

Comandos para copiar y pegar, en el orden en que se usan. Equipos involucrados:

| Equipo                   | Qué es                                                                                   | Consola                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Equipo de desarrollo** | Donde está el código y la llave de firma (`.secrets/release-signing.key`)                | PowerShell o Git Bash, en `C:\Users\juan.acosta\Desktop\RobotRPA` |
| **Servidor**             | `tecnologia@10.255.255.194` (`https://10.255.255.194`), pm2 con `rpa-api` y `rpa-worker` | bash (SSH)                                                        |
| **PC del robot**         | EQP4B-77, usuario de Windows AGENTERPA2, robot **46325302**                              | PowerShell (usar `&` y `$env:`)                                   |

Reglas:

- En el servidor **nunca** `pnpm db:migrate`: siempre `migrate:deploy`.
- Nunca copiar ni pegar el `.env` ni contraseñas.
- El paquete del robot solo se arma desde `main` actualizado (después del merge).

---

## 1. Actualizar el servidor (después de cada merge a `main`)

```bash
cd ~/rpa/backend
git pull origin main
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm --filter @abaya/db run migrate:deploy
pm2 restart rpa-api rpa-worker --update-env
pm2 ls
```

**Confirmación:** `rpa-api` y `rpa-worker` en `online`. Si uno se reinicia en bucle:

```bash
pm2 logs rpa-api --lines 50 --nostream --err
pm2 logs rpa-worker --lines 50 --nostream --err
```

### 1.b Actualizar el panel (solo si cambió `interfazRPA`)

nginx sirve una copia en `/var/www/rpa-frontend`; sin el `rsync` se sigue viendo el panel viejo.

```bash
cd ~/rpa/frontend && git pull && pnpm install --frozen-lockfile && pnpm build
sudo cp -a /var/www/rpa-frontend /var/www/rpa-frontend-respaldo-$(date +%F)
sudo rsync -a --delete ~/rpa/frontend/dist/ /var/www/rpa-frontend/
sudo chown -R www-data:www-data /var/www/rpa-frontend
curl -sk https://10.255.255.194/ | grep -o 'index-[^"]*\.js'
```

**Confirmación:** el nombre `index-….js` es el mismo que en `~/rpa/frontend/dist/index.html`. En el navegador, Ctrl+F5.

---

## 2. Crear el paquete del robot (equipo de desarrollo)

Solo cuando cambia el código del robot (`apps/rpa`).

```bash
cd C:/Users/juan.acosta/Desktop/RobotRPA
git checkout main
git pull origin main
pnpm install
TURBO_CONCURRENCY=1 pnpm build
pnpm robot:package -- --con-navegador
```

(En PowerShell, en lugar de `TURBO_CONCURRENCY=1 pnpm build`: `$env:TURBO_CONCURRENCY=1; pnpm build`.)

Al final dice `Paquete listo`, la **versión** (`1.0.0+<commit>.<fecha>`) y `Firmado`.

**Confirmación del paquete:**

```bash
cd C:/Users/juan.acosta/Desktop/RobotRPA/dist/robot-package
ls -l abaya-robot-windows.zip*
sha256sum abaya-robot-windows.zip
cat abaya-robot-windows.zip.manifest.json
```

- El `size` y el `sha256` del manifiesto deben ser iguales a los de `ls -l` y `sha256sum`.
- Tamaño esperado: unos **407 MB** (con navegador).
- Anotar los primeros 8 caracteres del sha para comprobarlo en el servidor.

---

## 3. Pasar el paquete al servidor

Desde el equipo de desarrollo (PowerShell):

```powershell
scp C:\Users\juan.acosta\Desktop\RobotRPA\dist\robot-package\abaya-robot-windows.zip C:\Users\juan.acosta\Desktop\RobotRPA\dist\robot-package\abaya-robot-windows.zip.manifest.json tecnologia@10.255.255.194:~/rpa/backend/dist/robot-package/
```

**Confirmación en el servidor:**

```bash
ls -l ~/rpa/backend/dist/robot-package/
sha256sum ~/rpa/backend/dist/robot-package/abaya-robot-windows.zip
```

- Mismo tamaño y mismo sha que en el equipo de desarrollo.
- Panel → **Robots** (Ctrl+F5): debe mostrar la versión nueva con **«Firma válida»**.

---

## 4. Instalar o reinstalar el robot en el PC

### 4.1 Detener el robot que está corriendo (sin perder chats)

1. En el Chromium del robot, pasar a **Break** (no entran casos nuevos).
2. Esperar a que la bandeja quede vacía.
3. **Ctrl+C** en la ventana «Robot Abaya». **Nunca cerrarla con la X**: ySocial deja la sesión abierta y el siguiente arranque falla con `ALREADY_CONNECTED`.

### 4.2 Borrar la descarga anterior

```powershell
cd $env:USERPROFILE
Remove-Item -LiteralPath "$env:USERPROFILE\Downloads\abaya-robot-windows" -Recurse -Force
Remove-Item "$env:USERPROFILE\Downloads\abaya-robot-windows*.zip"
```

### 4.3 Descargar y pedir el código

1. Panel → **Robots** → **Descargar instalador** (va a Descargas).
2. Clic derecho sobre el zip → **Extraer todo…** → **Extraer** (deja `Downloads\abaya-robot-windows`).
3. En la fila del robot **46325302** → **«Nuevo código (reinstalar)»**. El código sirve una sola vez y vence en 24 h.

### 4.4 Instalar

```powershell
cd "$env:USERPROFILE\Downloads\abaya-robot-windows\abaya-robot"
$env:NODE_EXTRA_CA_CERTS = "$env:LOCALAPPDATA\AbayaRobotCA\servidor-rpa.crt"
.\instalar.cmd -NoIniciar
cd $env:USERPROFILE
```

Pide:

- **Dirección del servidor:** `https://10.255.255.194` (sin ruta).
- **Código de instalación:** el del panel.

**Confirmación:** termina con
`Listo. Este equipo (EQP4B-77) quedó registrado como 46325302 (versión 1.0.0+…)`.
Los avisos de «Inicio de sesión automático» y «Excepción del antivirus» son pendientes de TI; no impiden que funcione.

- `-NoIniciar`: instala pero no arranca (para probar primero).
- Sin `-SinArranqueAutomatico`: arranca solo al iniciar sesión en Windows.

### 4.5 Si es un equipo nuevo (solo la primera vez): certificado del servidor

En `cmd`:

```
mkdir "%LOCALAPPDATA%\AbayaRobotCA"
scp tecnologia@10.255.255.194:/etc/nginx/ssl/rpa.crt "%LOCALAPPDATA%\AbayaRobotCA\servidor-rpa.crt"
setx NODE_EXTRA_CA_CERTS "%LOCALAPPDATA%\AbayaRobotCA\servidor-rpa.crt"
```

Cerrar la consola y abrir otra.

### 4.6 Otro usuario de Abaya

El panel no deja cambiar el usuario de Abaya de un robot (solo contraseña y MFA). Para otro usuario:
**Agregar robot** en el panel → instalar con su código. Un PC = un robot (cada instalación reemplaza
`robot.json`). Deshabilitar en el panel el robot anterior.

---

## 5. Pruebas antes de tráfico real (PC del robot)

Con el kill switch y la pausa del robot **apagados** en el panel. Cada paso incluye los anteriores; `--ver` muestra el navegador.

```powershell
& "$env:LOCALAPPDATA\AbayaRobot\probar.cmd" url --ver         # se ve el formulario de login
& "$env:LOCALAPPDATA\AbayaRobot\probar.cmd" login --ver       # inicia sesión (sin ponerse Disponible) y la cierra
& "$env:LOCALAPPDATA\AbayaRobot\probar.cmd" estado --ver      # estado del asesor y opciones del menú
& "$env:LOCALAPPDATA\AbayaRobot\probar.cmd" disponible --ver  # Disponible y vuelta a pausa (¡puede recibir un caso real!)
& "$env:LOCALAPPDATA\AbayaRobot\probar.cmd" bandeja --ver     # cuántos casos tiene asignados (no abre ninguno)
```

**Confirmación:** todo en `[OK]`. Una línea `[FALLA]` dice qué no encontró en la pantalla.
Mínimo antes de arrancar: `login --ver` en OK (confirma que la sesión de ySocial está libre).

### 5.1 Probar la conversación (panel de producción)

- **Agente → Probar agente:** prueba lo que responde el agente (guion, plantillas, planes, autorización).
- Aquí **no** hay reactivaciones ni cierre por inactividad (no hay robot ni temporizador).

### 5.2 Probar el robot completo en local (equipo de desarrollo, Abaya simulado)

Sirve para ver reactivaciones, cierres y transferencias sin clientes reales.

Opción rápida (base `abaya_rpa_demo` aparte y LLM simulado):

```bash
cd C:/Users/juan.acosta/Desktop/RobotRPA
pnpm build
pnpm demo --visible
```

Abre:

- Cliente simulado (aquí se escribe como cliente): http://127.0.0.1:4010/__cliente
- Panel: http://localhost:3000/panel (usuario `admin.demo`; la contraseña temporal sale en la consola)

En el cliente simulado: un número de chat nuevo (por ejemplo `900002`), escribir «Hola» y no responder
más. Debe llegar la reactivación a los 2–2,5 min, tres veces, y el cierre «Cliente abandona
conversación» a los 8 min. Ctrl+C detiene todo.

---

## 6. Iniciar el robot con tráfico real

### 6.1 Antes de arrancar

- [ ] Servidor actualizado (sección 1) y `pm2 ls` con todo `online`.
- [ ] Panel → Robots: versión del robot con «Firma válida».
- [ ] Panel → Agente: la versión publicada es la que se quiere usar.
- [ ] Horario de los robots (panel → Robots) cubre la hora actual (07:00–22:00).
- [ ] Kill switch apagado y robot sin pausa.
- [ ] `probar.cmd login --ver` en OK.
- [ ] Un supervisor mirando el panel y el Chromium del robot.

### 6.2 Arrancar

```powershell
& "$env:LOCALAPPDATA\AbayaRobot\iniciar.cmd"
```

(O cerrar y abrir la sesión de Windows: el arranque automático lo levanta.)

**Confirmación:**

- Panel → Robots: **En línea** en menos de un minuto, con la versión nueva.
- La ventana «Robot Abaya» muestra `sesión activa` y el robot pasa a Disponible en ySocial.
- Al llegar un caso: el saludo sale y en la ventana aparece `SENT_VERIFIED` (no `SEND_UNCERTAIN`).
- Si el cliente no responde: reactivación sola a los 2–2,5 min (3 veces) y cierre a los 8 min.

### 6.3 Si el robot se equivoca en un chat

1. Panel → **Pausar** el robot (deja de actuar al instante).
2. En el Chromium del robot, pasar a **Break**.
3. El asesor termina ese chat en el **mismo Chromium** (FINALIZAR) hasta que salga de la bandeja.
4. Panel → **Reanudar** y volver a **Disponible** en ySocial.

Con la versión del robot que trae D-031 (después de `681672e`): si el asesor hace **«Salir»** con el
robot en pausa, el robot **no** vuelve a entrar ni se pone Disponible (su ventana dice «robot en
pausa: no entra a Abaya hasta que lo reanuden en el panel»). Al pulsar **Reanudar**, entra solo y se
pone Disponible en menos de un minuto. No hace falta Ctrl+C ni reiniciar. Con versiones anteriores,
el robot volvía a entrar solo apenas el asesor hacía «Salir».

### 6.4 Terminar el turno a mano

**Break** → esperar la bandeja vacía → **Ctrl+C** en «Robot Abaya». Nunca con la X.
(A la hora de fin del horario lo hace solo: FinTurno, termina sus chats, «Salir» y espera al día siguiente.)

### 6.5 Emergencia

Panel → **Apagado de emergencia** (kill switch) o **Pausar**. El supervisor reasigna los chats y desconecta al agente en ySocial.

---

## 7. Problemas frecuentes

| Qué se ve                              | Qué hacer                                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALREADY_CONNECTED` al arrancar        | La sesión de ySocial quedó abierta (se cerró con la X o con chats). Pedir al supervisor de ySocial que desconecte al agente y repetir `probar.cmd login --ver`. |
| `ROBOT_DUPLICATE`                      | Otro proceso del mismo robot sigue vivo. Cerrarlo con Ctrl+C y esperar 1 min.                                                                                   |
| `SEND_UNCERTAIN`                       | El robot no pudo confirmar que el mensaje salió; no lo reenvía. Revisar el chat y, si falta, enviarlo a mano. Pasar el log a desarrollo.                        |
| `SEND_STALE`                           | Respuesta de más de 5 min (por ejemplo, preparada durante una pausa): no se envía, a propósito.                                                                 |
| El panel no muestra cambios            | Faltó el `rsync` (sección 1.b) o Ctrl+F5.                                                                                                                       |
| Robot «Apagado» en el panel en horario | Revisar la ventana «Robot Abaya»; si no está, `iniciar.cmd`.                                                                                                    |
