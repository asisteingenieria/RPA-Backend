# Runbook de operación — Agente RPA de ventas en Abaya

> Para el equipo de operación. Panel: `https://<api>/panel` (usuario y contraseña personales; todo
> queda en la auditoría con tu usuario). Contactos en Claro: **[completar en el despliegue]**.

## 1. Apagado de emergencia (kill switch)

**Cuándo:** el robot escribe algo incorrecto, en el chat equivocado, o cualquier duda seria.

1. Panel → **Apagado de emergencia** → **Sí, detener**. Efecto inmediato: ninguna acción nueva sobre
   Abaya (enviar, nota, transferir, cerrar). La lectura de mensajes sigue, nada se pierde.
2. Alternativa sin panel: `redis-cli SET abaya:killswitch 1`.
   El sistema también lo activa **solo** si el modelo de IA no responde (D-009, alerta
   `LLM_OUTAGE`): ver la sección 2.
3. Si Redis no responde, el robot **ya está detenido** (falla cerrado).
4. Para reanudar: Panel → **Reanudar robot** (solo rol ADMIN; un OPERADOR puede detener pero no
   reanudar). Los envíos pendientes se procesan en orden.
5. Revisar en el panel la sección **Requieren revisión humana** antes de reanudar.

## 2. Procedimiento por alerta (sección 11)

| Alerta                       | Severidad | Qué significa                                                                                                                                                                                                                                      | Qué hacer                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_DOWN`               | Crítica   | El robot falló 3 logins seguidos y dejó de intentar (para no bloquear el usuario).                                                                                                                                                                 | 1) Entrar a mano a Abaya con el usuario robot desde la máquina del robot. 2) Si la contraseña expiró o el usuario está bloqueado: gestionar con Claro y actualizar el secreto. 3) Si hay MFA nuevo: revisar `ABAYA_MFA_MODE`/TOTP. 4) Panel → **Habilitar reintento** y reiniciar el proceso `rpa` de ese robot. |
| `HEARTBEAT_LOST`             | Crítica   | El robot no reporta hace más de 2 min (proceso caído o colgado).                                                                                                                                                                                   | Ver estado del contenedor `rpa`; reiniciarlo. Al arrancar, reconcilia solo (reencola envíos y revisa la bandeja).                                                                                                                                                                                                |
| `ROBOT_DUPLICATE`            | Crítica   | Se intentó arrancar un robot en un segundo equipo mientras estaba en línea en otro (o el mismo robot quedó en dos equipos). El segundo no inicia sesión en Abaya.                                                                                  | 1) Panel → Robots: el aviso de la fila muestra los dos equipos. 2) Dejar el robot en un solo equipo: cerrar la ventana "Robot Abaya" en el sobrante y, si se instaló por error, `desinstalar.cmd`. 3) Si el robot debía pasar a otro equipo: apagar el viejo, **Reinstalar** en el panel e instalar en el nuevo. |
| `ROBOT_TOKEN_REUSE`          | Crítica   | Se presentó un token de renovación ya usado: copia del archivo `robot.json` o robo del equipo. El servidor ya revocó ese robot.                                                                                                                    | 1) Ubicar el equipo legítimo del robot (panel → Robots). 2) Revisar quién tuvo acceso al equipo o a su carpeta. 3) Cambiar la contraseña de Abaya del robot (**Credenciales**). 4) **Reinstalar** con código nuevo en el equipo legítimo.                                                                        |
| `ROBOT_UPDATE_FAILED`        | Alta      | Una actualización no se instaló (firma o paquete inválido) o se instaló y no arrancó: el robot volvió solo a la versión anterior y sigue trabajando.                                                                                               | 1) Panel → Robots: el estado ("Actualización fallida" / "Revertida") y su mensaje. 2) Firma inválida: revisar que el paquete se armó con la clave de publicación correcta. 3) Revertida: revisar la traza o los registros del equipo antes de volver a publicar. El robot no la reintenta solo.                  |
| `SELECTOR_BROKEN`            | Crítica   | 3 acciones seguidas fallidas: probable **cambio en la interfaz de Abaya**.                                                                                                                                                                         | 1) Kill switch. 2) Abrir la traza del error (sección 5). 3) Actualizar `apps/rpa/src/abaya/selectors.ts` con fixtures nuevos sanitizados y pasar las pruebas. 4) Desplegar y reanudar.                                                                                                                           |
| `SALE_NOT_TRANSFERRED`       | Crítica   | Un cliente **autorizó** y su venta no llegó al backoffice en 5 min. **Es una venta en riesgo.**                                                                                                                                                    | 1) Panel → revisión: ubicar el chat. 2) En Abaya: escribir la nota con el resumen (consultar con soporte técnico) y transferir a mano a la cola de backoffice. 3) Marcar la conversación como resuelta (soporte técnico).                                                                                        |
| `LLM_OUTAGE`                 | Crítica   | El modelo de IA no respondió (timeout, cuota/429, error del servidor o API key inválida). **Todos los robots quedaron pausados** (D-009); la banda roja del panel muestra el error. Los mensajes de los clientes quedan pendientes, no se pierden. | Revisar la consola del proveedor (cuota, facturación, API key, estado del servicio). Cuando esté resuelto, Panel → **Reanudar robot** (ADMIN): el robot responde todo lo pendiente.                                                                                                                              |
| `CONVERSATIONS_NEEDS_REVIEW` | Alta      | Hay conversaciones que el robot no puede continuar (transferencia incierta, chat desaparecido de la bandeja).                                                                                                                                      | Atender cada una desde Abaya. Si el LLM estaba caído y ya volvió, soporte técnico puede reactivarla.                                                                                                                                                                                                             |
| `SEND_UNCERTAIN`             | Alta      | El robot envió un mensaje y no pudo confirmar que llegó. **No se reintenta solo.**                                                                                                                                                                 | Abrir el chat en Abaya: si el mensaje no está, escribirlo a mano o reactivar; si está, no hacer nada.                                                                                                                                                                                                            |
| `CUSTOMER_UNANSWERED`        | Alta      | Hay mensajes de clientes sin atender hace más de 2 min.                                                                                                                                                                                            | Revisar el worker (logs, proveedor LLM) y la cola; si el robot está detenido, atender a mano.                                                                                                                                                                                                                    |
| `ROBOT_OVERLOADED`           | Alta      | Un robot tiene más chats abiertos que el tope (`MAX_CHATS_PER_ROBOT`, 3). Sus clientes esperan más.                                                                                                                                                | 1) Panel → Robots: columna **Chats**. 2) Confirmar con Claro que Abaya limite a 3 chats por usuario robot. 3) Si es un pico puntual, vigilar la columna **Respuesta p95**; si persiste, agregar un robot (otro equipo).                                                                                          |
| `RESPONSE_SLOW`              | Alta      | El 95 % de las respuestas de un robot tardó más de 20 s en los últimos 15 min.                                                                                                                                                                     | 1) Panel → Robots → **Ver**: ¿muchos chats abiertos, errores o acciones lentas (p95 de "Enviar mensaje")? 2) Si todas las acciones son lentas: red o equipo del robot (CPU/memoria) o Abaya lento. 3) Si solo el motor: revisar `LLM_PROVIDER_ERRORS` y el proveedor de respaldo.                                |
| `LLM_PROVIDER_ERRORS`        | Alta      | Más del 5 % de turnos fallan por el proveedor de IA en 10 min.                                                                                                                                                                                     | Revisar el estado del proveedor. Si persiste: kill switch o cambiar `LLM_PROVIDER`/`LLM_MODEL` a la alternativa **evaluada** (regla 13) y reiniciar el worker.                                                                                                                                                   |
| `LLM_FALLBACK_RATE`          | Alta      | Más del 5 % de respuestas cayeron en respuesta segura en 1 h: posible degradación del modelo o del prompt.                                                                                                                                         | Correr `pnpm evals -- --provider <actual>` y comparar con el último reporte; revertir el último cambio de prompt/modelo si empeoró.                                                                                                                                                                              |
| `SMOKE_TEST_FAILED`          | Alta      | La prueba de humo (cada 15 min) no pudo leer la bandeja.                                                                                                                                                                                           | Igual que `HEARTBEAT_LOST`; si la sesión está activa pero la bandeja no se lee, tratar como `SELECTOR_BROKEN`.                                                                                                                                                                                                   |
| `CHATS_MISSING_FROM_INBOX`   | Alta      | Al reconciliar, chats abiertos en BD ya no están en la bandeja del robot (los movió un humano o expiraron).                                                                                                                                        | Confirmar en Abaya quién los tiene; quedaron en revisión.                                                                                                                                                                                                                                                        |
| `SEND_IMAGE_MISSING`         | Alta      | El robot iba a enviar una imagen de planes que ya no existe en el servidor (la versión del Brain se purgó). No se envió nada.                                                                                                                      | Revisar que el Brain de imágenes esté publicado y conectado; responder al cliente a mano si hace falta.                                                                                                                                                                                                          |
| `CLOSE_UNCERTAIN`            | Alta      | Un cierre sin venta no se pudo confirmar.                                                                                                                                                                                                          | Cerrar a mano en Abaya.                                                                                                                                                                                                                                                                                          |

## 3. Reiniciar un proceso

- `docker compose restart rpa|worker|api`. Es seguro en cualquier momento:
  - mensajes entrantes ya guardados no se pierden (el worker retoma los no atendidos);
  - envíos `PENDING`/`SENDING` se reencolan y el actor verifica en pantalla antes de reenviar;
  - nada se duplica (huella única, idempotencia en pantalla, outbox con `jobId`).

## 4. Rotación de la clave de cifrado

1. Generar clave nueva: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. En el gestor de secretos: `FIELD_ENCRYPTION_PREVIOUS_KEYS=<idViejo>:<claveVieja>`,
   `FIELD_ENCRYPTION_KEY=<nueva>`, `FIELD_ENCRYPTION_KEY_ID=<idViejo+1>`.
3. Reiniciar `rpa`, `worker` y `api`. Lo nuevo se cifra con la clave nueva; lo viejo sigue legible.
4. Cuando se re-cifren o expiren los datos viejos (política de retención), retirar la clave anterior.

## 5. Acceso a trazas de error

Las trazas (pantalla del navegador en el momento del error) contienen datos personales: están
cifradas en `TRACE_DIR`, se borran a los 7 días y su referencia está en `RpaActionLog.traceRef`.
Acceso solo para soporte técnico, registrado en el ticket del incidente:

```bash
node -e "import('./apps/rpa/dist/observability/trace-recorder.js').then(async m => {
  const { cipherFromConfig } = await import('@abaya/crypto');
  const { loadConfig } = await import('@abaya/config');
  await m.decryptTrace(process.env.TRACE_DIR, '<traceRef>', cipherFromConfig(loadConfig()), '/tmp/traza.zip');
})"
npx playwright show-trace /tmp/traza.zip   # borrar /tmp/traza.zip al terminar
```

## 6. Usuarios del panel

Roles: **ADMIN** (todo, incluida la gestión de usuarios, reanudar el robot, habilitar reintentos y
ver la auditoría) y **OPERADOR** (consulta, revisión y apagado de emergencia).

- **Primer ADMIN** (en el servidor, con acceso a la base de datos):
  `pnpm --filter @abaya/api create-admin -- <usuario>`. Imprime una contraseña temporal una sola vez.
- **Crear usuario:** Panel → **Usuarios** → Crear. La contraseña temporal se muestra una vez:
  entregarla por un canal seguro (nunca por el chat del equipo ni por correo sin cifrar).
- **Primer ingreso:** el panel obliga a cambiar la contraseña temporal (mínimo 12 caracteres).
- **Bloqueo:** 5 contraseñas incorrectas bloquean la cuenta 15 min. Un ADMIN puede desbloquearla
  con **Restablecer contraseña** (genera una temporal nueva y cierra sus sesiones).
- **Baja de una persona:** Panel → Usuarios → **Desactivar** el mismo día (cierra sus sesiones). No
  se borran usuarios: la auditoría conserva quién hizo qué.
- **Nadie puede entrar** (se perdió la contraseña del último ADMIN): en el servidor,
  `pnpm --filter @abaya/api create-admin -- <usuario> --reset`. Queda auditado como `consola`.
- Sesión: máximo 8 h y 30 min de inactividad; luego hay que volver a entrar.

### 6.b Trazabilidad: ver conversaciones (D-002)

- La pestaña **Trazabilidad** del panel muestra cada conversación completa, **sin enmascarar**.
  La ve **todo ADMIN** (no hay permiso aparte); el OPERADOR no. Tratar las cuentas ADMIN como
  acceso a datos personales: nominales, nunca compartidas.
- Cada apertura de una conversación (`CONVERSATION_VIEWED`, una vez cada 10 min por persona) y
  cada exportación (`CONVERSATIONS_EXPORTED`, CSV sin texto o transcripción) queda en Auditoría.
- **Retención:** `CONVERSATION_RETENTION_DAYS` (vacío = no se borra). El worker revisa cada hora y
  borra mensajes, perfil, resumen de la venta y respuesta del consentimiento de las conversaciones
  **cerradas** hace más de N días; la conversación queda con su tipificación y `contentPurgedAt`.
  Cambiar el plazo = cambiar la variable y reiniciar el worker. No hay vuelta atrás (salvo respaldo).

## 7. Robots por equipo (padre / hijos)

Cada computador es un robot hijo con su propio usuario de Abaya. El servidor (padre) guarda las
credenciales cifradas y entrega la configuración a cada equipo al arrancar.

- **Agregar un equipo:** Panel → **Robots** → **Agregar robot** (usuario y contraseña de Abaya;
  secreto TOTP si hay MFA). Copiar el código de instalación (un solo uso, 24 h). En el equipo:
  **Descargar instalador** desde el panel, descomprimir y ejecutar `instalar.cmd` con la dirección
  del servidor y el código. Debe aparecer **En línea** con el nombre del equipo en menos de 1 min.
- **Código vencido o perdido:** **Reinstalar** genera uno nuevo.
- **Pausar un robot** (sin afectar a los demás): **Pausar**. No ejecuta acciones en Abaya hasta
  **Reanudar**; sigue leyendo mensajes, nada se pierde. Para detener a todos: apagado de emergencia.
- **Cambiar la contraseña de Abaya:** **Credenciales**. El robot la toma en su próximo arranque
  (cerrar la ventana "Robot Abaya" y abrir `iniciar.cmd`).
- **Actualizar la versión (v1.7):** ver la sección 10. Desde el panel, sin ir a los equipos.
- **Equipo robado, perdido o retirado:** **Deshabilitar**. Revoca su token: si está encendido se
  apaga en menos de 15 s y no vuelve a arrancar. El equipo nunca guardó la contraseña de Abaya;
  aun así, cambiarla en Abaya si el equipo no se recupera.
- **Estados:** _En línea_ (trabajando), _Reconectando_ (volviendo a entrar a Abaya), _Caído (login)_
  (3 logins fallidos: revisar credenciales y luego **Habilitar reintento** en Operación),
  _Sin señal_ (no reporta hace más de 1 min: equipo apagado sin aviso, sin red o colgado),
  _Apagado_ (cerrado en orden), _Deshabilitado_.
- **Trazas de error:** Robots → **Ver** → "Trazas de error" (solo ADMIN). Cada descarga queda
  auditada. Abrir con `npx playwright show-trace archivo.zip`.
- **Usuario de Windows:** el archivo del robot está protegido con DPAPI para el usuario que
  instaló. El robot debe correr con **ese mismo usuario** (el instalador crea el arranque
  automático para él); si se cambia de usuario, reinstalar con un código nuevo.
- **Ventana del robot en el equipo:** si dice que el servidor rechazó el equipo, revisar en el
  panel si está deshabilitado, duplicado o si hay que reinstalar con un código nuevo.

## 8. Cambiar prompts, modelo o catálogo

1. Cambiar en código (prompts) o cargar el catálogo nuevo: `pnpm --filter @abaya/worker seed -- <archivo>`.
2. **Regla 13:** correr `pnpm evals -- --provider <proveedor>`; meta 0 datos inventados y ≥ 95 %.
3. Adjuntar el reporte (`evals/reports/`) al cambio. Sin evaluación aprobada, no se despliega.

### 8.b Oferta con imágenes (D-014)

1. **Cargar las imágenes:** Agente → Conocimiento → Brain sin Excel → Agregar fuente → «Imagen de planes». Marca el proceso de cada imagen, o «Apps de video» para la circular.
2. **Revisar lo leído:** en la tabla de fuentes, compara cada tarjeta con su imagen y usa «Reprocesar» si algo no coincide. Es lo único que el agente puede decir de esos planes.
3. **Publicar:** «Publicar Brain con evaluación» corre la suite (~1,4 M tokens de Gemini) y exige 0 datos inventados y ≥ 95 %. Después «Conectar al agente»: solo puede haber un catálogo conectado.
4. **Activar en conversaciones reales:** `SEND_PLAN_IMAGES=true` en el worker, solo después de probar el envío de imágenes en Abaya real. Mientras tanto se ofrece en texto con los mismos planes.

### 8.c Llevar el agente y los Brains a otro ambiente (D-019)

Lo que se ajusta en el panel (guion, plantillas, flujo, descuentos, imágenes) vive en la base de
datos, no en el código. Para pasarlo de local (o pruebas) a producción, sin escribir nada a mano:

1. **Brains**, en el ambiente de origen: Agente → Conocimiento → el Brain → botón de descarga
   «Exportar Brain». Sale un `brain-<nombre>-<fecha>.json` con sus fuentes (imágenes con lo leído y
   sus descuentos, catálogo, documentos, textos y direcciones web).
2. En producción: Conocimiento → **Crear Brain → «Importar de otro ambiente»** y el archivo. Queda un
   Brain nuevo en borrador (las imágenes no se vuelven a leer). Revisar, **Publicar Brain con
   evaluación** y **Conectar al agente**.
3. **Agente**, en el origen: Agente → Historial → «Exportar» en la versión publicada. Sale
   `agente-v<N>-<fecha>.json` (guion, plantillas con sus mismos nombres, flujo, reactivación y ajustes).
4. En producción: Agente → Historial → **Importar versión** y el archivo. Queda como borrador (si ya
   hay uno, hay que publicarlo o descartarlo antes). Pasa por la misma revisión que guardar: si el
   guion nombra una plantilla que no existe, lo dice. Si el modelo no está permitido en producción,
   queda el modelo por defecto (se avisa).
5. Probar en «Probar agente», evaluar y publicar.

El orden importa: primero el Brain (conectado y publicado), después el agente, así la evaluación del
agente corre con el catálogo real.

### 8.d Alerta de amenaza del cliente (D-018)

`CUSTOMER_THREAT` (alta): un cliente escribió una amenaza de violencia. El robot ya le respondió con
un límite y siguió la conversación; la alerta solo trae el id. Un supervisor revisa la conversación
en Trazabilidad y decide si se escala (seguridad de Claro, autoridades).

### 8.e Probar Abaya real por pasos (D-020)

Para ver, una cosa a la vez, que el robot funciona en Abaya real. Con el robot **detenido** (cerrar
la ventana «Robot Abaya»; si está en línea, el diagnóstico no arranca) y sin kill switch ni pausa
del robot en el panel:

```
%LOCALAPPDATA%\AbayaRobot\probar.cmd url          # abre Abaya: ¿se ve el formulario de login?
%LOCALAPPDATA%\AbayaRobot\probar.cmd login        # + inicia sesión (sin ponerse Disponible)
%LOCALAPPDATA%\AbayaRobot\probar.cmd estado       # + estado del asesor y opciones del menú
%LOCALAPPDATA%\AbayaRobot\probar.cmd disponible   # + Disponible y vuelta inmediata a una pausa
%LOCALAPPDATA%\AbayaRobot\probar.cmd bandeja      # + cuántos casos tiene asignados (no abre ninguno)
```

Agregar `--ver` para mirar el navegador. Cada paso corre los anteriores y se detiene en el primero
que falle; la línea `[FALLA]` dice qué no encontró (el selector a ajustar en `selectors.ts`).
Al terminar hace **Salir** en Abaya («Sesión cerrada en Abaya»): cerrar el navegador no cierra la
sesión del asesor y el siguiente login diría «ya se encuentra conectado» (`ALREADY_CONNECTED`).
Con `--dejar-abierto` (en PowerShell: `& "$env:LOCALAPPDATA\AbayaRobot\probar.cmd" login --dejar-abierto`)
la ventana queda abierta para mirarla: cerrar sesión a mano (iniciales arriba a la derecha → ícono
de apagado → ACEPTAR) y después cerrar la ventana; ahí termina el diagnóstico. Si
quedó una sesión abierta sin salir, cerrarla así desde un navegador con la sesión, esperar a que
venza o pedir al supervisor que desconecte al agente.
Las credenciales salen del servidor, como para el robot. En desarrollo:
`pnpm --filter @abaya/rpa build && pnpm --filter @abaya/rpa probar-abaya -- <paso> [--ver]`
(usa el `.env`).

- **`disponible` asigna casos reales:** el paso vuelve enseguida a la pausa. Si dice «ATENCIÓN:
  entró un caso», atenderlo en Abaya; si dice «NO volvió», cambiar el estado a mano ya.
- En equipos instalados antes de esta versión, `probar.cmd` no está: reinstalar con el paquete
  nuevo (o copiar `probar.cmd` y `probar.ps1` del paquete a `%LOCALAPPDATA%\AbayaRobot`).

## 9. Lista de verificación de despliegue

- [ ] Autorización escrita de Claro y acuerdo de encargo de tratamiento de datos.
- [ ] Textos legales y catálogo **oficiales** cargados (hallazgos A3/A4 de `security-review.md`).
- [ ] Usuario robot dedicado (`robot-ventas-NN`), permisos mínimos, MFA resuelto.
- [ ] `ABAYA_BASE_URL` y `ROBOT_PACKAGE_FILE` en el servidor; solo el puerto 443 abierto (los robots no
      acceden a PostgreSQL ni a Redis, v1.6);
      `/robot-api` publicado por HTTPS; paquete del robot armado con `pnpm robot:package`.
- [ ] Secretos inyectados desde el gestor (no `.env` en la máquina): `ABAYA_PASSWORD`,
      `FIELD_ENCRYPTION_KEY`, claves del LLM.
- [ ] Panel solo por HTTPS (`ADMIN_COOKIE_SECURE=true`, obligatorio en producción); primer ADMIN
      creado con `create-admin` y cuentas nominales para cada persona (nunca compartidas).
- [ ] PostgreSQL con `sslmode=require` y usuario con permisos mínimos; `pnpm --filter @abaya/db migrate:deploy`.
- [ ] Redis con contraseña (y TLS si sale de la máquina).
- [ ] Red: el robot solo sale a Abaya y al proveedor del LLM; `/health` y `/panel` solo desde la red interna.
- [ ] Panel detrás de SSO corporativo (recomendado, hallazgo M3) y `trust proxy` configurado.
- [ ] `ALERT_WEBHOOK_URL` configurado y **cada alerta disparada a propósito una vez** (criterio F7).
- [ ] Proveedor LLM sin entrenamiento con los datos y con contrato que cubra la transferencia
      internacional (Ley 1581), o modelo en la nube contratada por Claro.
- [ ] Suite de evaluación aprobada con el proveedor y modelo finales.
- [ ] Piloto: 1 robot, horario limitado, revisión diaria de conversaciones con Claro.

## 10. Actualizar los robots (v1.7)

**Una sola vez — claves de publicación:** en el equipo donde se arma el paquete, `pnpm robot:keys`.
La clave **privada** (`.secrets/release-signing.key`) se guarda en el gestor de secretos o en una
bóveda: **nunca** en el repositorio, el servidor ni los equipos. La **pública**
(`apps/rpa/release-key.pub`) viaja dentro de cada robot y la usa el servidor
(`ROBOT_RELEASE_PUBLIC_KEY`). Si la privada se pierde o se filtra: `pnpm robot:keys --forzar` y
reinstalar todos los robots con un paquete nuevo (los instalados no aceptarán la clave nueva).

**Publicar una versión:**

1. `pnpm build && pnpm robot:package` (en Windows). Genera el zip y su manifiesto firmado
   (`abaya-robot-windows.zip.manifest.json`).
2. Copiar **ambos** archivos a la ruta de `ROBOT_PACKAGE_FILE` en el servidor.
3. Panel → Robots: aparece "Versión publicada: … **Firma válida**". Si dice "Firma inválida", no
   se ofrecerá a ningún robot.
4. **Actualizar** (un robot, para probar) o **Actualizar todos**.

**Qué hace cada robot:** descarga y verifica en segundo plano (sigue atendiendo), espera a tener
la bandeja vacía ("Esperando a terminar sus chats"), se reinicia en la versión nueva (unos 20 s
fuera de línea) y la confirma tras 2 minutos en línea ("Actualizado"). Si la nueva no arranca,
el lanzador **vuelve solo a la anterior** ("Revertida") y alerta `ROBOT_UPDATE_FAILED`.
Probado de punta a punta: actualización 1 → 2 y reversión automática de una versión rota en 11 s.

**Botón local:** `actualizar.cmd` en la carpeta del robot pide la última versión publicada (útil
si el panel no está disponible). La firma se verifica igual.

**Cambios en el lanzador o el instalador** (`iniciar.ps1`, `instalar.ps1`) no viajan en la
actualización automática: requieren **Reinstalar** con código nuevo.

**Preparación de cada equipo:** el instalador deja `preparacion.txt` con avisos (suspensión,
horas activas de Windows Update, inicio de sesión automático, espacio en disco, excepción del
antivirus). Resolver los avisos con TI antes de poner el equipo en producción.

## 11. Respaldo y recuperación del servidor

- **Respaldo diario** (cron del servidor, fuera del horario de atención):

  ```bash
  docker compose exec -T postgres pg_dump -U abaya -Fc abaya_rpa > /respaldos/abaya_rpa_$(date +%F).dump
  find /respaldos -name 'abaya_rpa_*.dump' -mtime +30 -delete   # retención: la que defina Claro
  ```

  Copiar los respaldos fuera del servidor (otro equipo o almacenamiento de la empresa). Los
  mensajes, perfiles, resúmenes y consentimientos van cifrados dentro del respaldo: **guardar
  aparte** `FIELD_ENCRYPTION_KEY` (gestor de secretos); sin ella el respaldo no sirve.

- **Prueba de restauración (mensual):** restaurar el último respaldo en una base temporal y
  comprobar que el panel abre con esos datos:

  ```bash
  docker compose exec -T postgres createdb -U abaya abaya_rpa_prueba
  docker compose exec -T postgres pg_restore -U abaya -d abaya_rpa_prueba < /respaldos/abaya_rpa_AAAA-MM-DD.dump
  docker compose exec -T postgres dropdb -U abaya abaya_rpa_prueba
  ```

- **Si el servidor cae:** los robots dejan de actuar solos (falla cerrado) y nada se escribe en
  Abaya. Restaurar el último respaldo, levantar `postgres`, `redis`, `worker` y `api`; los robots
  se reconectan solos y reconcilian sus chats.

## 12. Producción (servidor actual, desde el 14/10/2026)

### 12.1 Cómo está montado

- **Servidor** Linux en la red interna, `https://10.255.255.194` (el panel; los robots usan la
  misma dirección). Usuario de sistema `tecnologia`.
- **Código:** `~/rpa/backend` es un clon de `main` de `asisteingenieria/RPA-Backend` con una llave
  de despliegue (`~/.ssh/rpa_deploy`, alias `github-rpa` en `~/.ssh/config`). Hoy la llave quedó
  con permiso de **escritura**: pasarla a solo lectura en GitHub (Settings → Deploy keys: borrarla y
  agregarla otra vez sin «Allow write access»; en el servidor no cambia nada).
- **Procesos:** pm2 con `~/rpa/ecosystem.config.cjs`: `rpa-api` y `rpa-worker` (cada uno corre
  `apps/<proceso>/dist/main.js` con `--env-file-if-exists=../../.env`). El `rpa` no corre en el
  servidor: va en el PC del robot.
- **Configuración:** `~/rpa/backend/.env` (permisos 600; nunca copiarlo ni pegarlo). Lleva
  `ABAYA_BASE_URL=https://claro-co.ysocial.net/agent/`. `.secrets` está vacía en el servidor: la
  clave privada de firma de paquetes **no** va ahí (queda en el equipo que arma los paquetes).
- **nginx:** HTTPS con certificado autofirmado para la IP (`/etc/nginx/ssl/rpa.crt`, SAN
  `IP:10.255.255.194`, vence el 15/01/2029). `/admin`, `/robot-api`, `/health` y `/panel` van a la
  API (`127.0.0.1:3000`) con `Upgrade`/`Connection` para el WebSocket y `proxy_read_timeout 300s`
  (el robot manda un latido cada 30 s). El resto es el panel `interfazRPA` (`~/rpa/frontend/dist`).
- **Paquete del robot:** `~/rpa/backend/dist/robot-package/abaya-robot-windows.zip` y su
  `.manifest.json` (versión `1.0.0+16b02c7.202610141527`). El panel → Robots debe decir «Firma
  válida».
- **Respaldos del 14/10/2026:** `~/rpa/backend-respaldo-2026-10-14.tar.gz` (el código antes de
  pasarlo a clon) y `~/rpa/backend/.env.respaldo-2026-10-14`.

### 12.2 Actualizar el servidor con lo último de `main`

```bash
cd ~/rpa/backend
git pull
pnpm install --frozen-lockfile
pnpm db:generate
pnpm build
pnpm --filter @abaya/db run migrate:deploy
pm2 restart rpa-api rpa-worker
pm2 ls
```

- En el servidor **nunca** `pnpm db:migrate` (es `prisma migrate dev`, de desarrollo: puede
  ofrecer borrar la base). En producción siempre `migrate:deploy`.
- Ambos procesos deben quedar `online`. Si uno se reinicia en bucle: `pm2 logs rpa-api --lines 50
--nostream --err`.
- Cambiar el `.env`: respaldarlo (`cp .env .env.respaldo-$(date +%F)`), editar y
  `pm2 restart rpa-api rpa-worker --update-env`.

### 12.3 Pendiente de subir a producción (cambios del 14/10/2026)

D-021 (proceso según el operador), D-022 (plataforma de video pedida), D-023 (consulta de
portabilidad y tabla `ServiceCase`), D-024 (planes compartidos solo con uso laboral), D-025 (tipificación del cierre sin venta) y la corrección
de «Probar agente» están en el repositorio local sin commit (y el panel `interfazRPA`, con el modo
nuevo del flujo, también). Para llevarlos:

1. Commit en una rama, push, PR hacia `main` con el CI en verde y merge.
2. En el servidor, §12.2. Trae la migración `20261026000000_caso_servicio` (`migrate:deploy` debe
   decir que la aplicó).
3. Trae también la migración `20261027000000_tipificacion` (D-025). El paquete del robot **sí**
   cambia con D-025 (el robot marca la etiqueta que eligió el modelo): `pnpm robot:package` en el
   equipo que firma y publicarlo (§8). Un robot anterior sigue funcionando: ignora la
   tipificación y cierra con la etiqueta por motivo.
4. Agente: en el panel **local** exportar la v23 (Configuración → versiones → Exportar) e
   importarla en producción (§8.c, D-019): queda como borrador → revisarla en «Probar agente» →
   **Evaluar** (regla 13) → publicar. La v22 es el guion de la v21 más la regla de D-022 en OFERTA;
   la v23 suma D-024 (guion y flujo: compartidas «Solo si el uso es laboral» en Portabilidad y
   Migración). El flujo nuevo (D-021 a D-023) y sus plantillas del sistema toman lo de la campaña si
   faltan.
5. Probar en producción con «Probar agente»: `A` → `Claro` → `No` (debe ofrecer migración);
   `hola quiero un plan con WIN` → `B` (la circular de WIN); `solicité una portabilidad y no sé si
quedó` → `no` (pide los datos y transfiere como validación); `B` → `para el trabajo` → `WhatsApp`
   (primero la imagen de 99.900, 75.900 y 65.900; «más barato» → las de migración) y `B` → `redes` →
   `TikTok` (no aparecen los planes compartidos).

### 12.4 Instalar el robot en el PC dedicado (pendiente)

En el PC del robot, con el usuario de Windows que lo va a correr:

1. **Confiar en el certificado del servidor** (autofirmado; Node.js no usa el almacén de Windows).
   En una consola `cmd`:
   ```
   mkdir "%LOCALAPPDATA%\AbayaRobotCA"
   scp tecnologia@10.255.255.194:/etc/nginx/ssl/rpa.crt "%LOCALAPPDATA%\AbayaRobotCA\servidor-rpa.crt"
   setx NODE_EXTRA_CA_CERTS "%LOCALAPPDATA%\AbayaRobotCA\servidor-rpa.crt"
   ```
   Es el certificado **público**; la llave (`rpa.key`) nunca sale del servidor. Cerrar la consola y
   abrir otra (la variable solo vale en consolas nuevas). Si se renueva el certificado del servidor,
   repetir el `scp`.
2. Panel de producción → Robots: el robot ya existe (usuario de Abaya, «Sin MFA»). Si el código de
   instalación venció (24 h), **Reinstalar** para uno nuevo.
3. Panel → **Descargar instalador**, descomprimir y, en una consola en esa carpeta:
   ```
   instalar.cmd -NoIniciar -SinArranqueAutomatico
   ```
   Servidor: `https://10.255.255.194` (sin `/robots` ni otra ruta). Código: el del panel.
   `-NoIniciar` es obligatorio en la primera vez: sin él el robot entra a Abaya y se pone
   Disponible (recibiría casos reales).
4. Probar por pasos (§8.e), con el kill switch y la pausa del robot apagados en el panel:
   ```
   %LOCALAPPDATA%\AbayaRobot\probar.cmd url --ver
   %LOCALAPPDATA%\AbayaRobot\probar.cmd login --ver
   %LOCALAPPDATA%\AbayaRobot\probar.cmd estado --ver
   %LOCALAPPDATA%\AbayaRobot\probar.cmd disponible --ver
   %LOCALAPPDATA%\AbayaRobot\probar.cmd bandeja --ver
   ```
   `disponible` puede recibir un caso real: correrlo con poco tráfico. Una línea `[FALLA]` dice qué
   selector no encontró (se ajusta en `selectors.ts`).
5. Con todo en `[OK]` y en el horario de piloto acordado con Claro: `%LOCALAPPDATA%\AbayaRobot\iniciar.cmd`.
   Para que arranque con Windows, **Reinstalar** en el panel e instalar sin `-SinArranqueAutomatico`.

### 12.5 Publicar un paquete nuevo del robot

Solo cuando cambia el código del robot (`apps/rpa`). En el equipo de desarrollo (el que tiene
`.secrets/release-signing.key`), desde `main` actualizado:

```
pnpm install
pnpm build
pnpm robot:package -- --con-navegador
```

Si el equipo tiene poca memoria libre (el paso falla con exit 134), cerrar el `pnpm dev` o correr
`$env:TURBO_CONCURRENCY=1` antes. Copiar los dos archivos al servidor:

```powershell
scp dist\robot-package\abaya-robot-windows.zip dist\robot-package\abaya-robot-windows.zip.manifest.json tecnologia@10.255.255.194:~/rpa/backend/dist/robot-package/
```

El panel → Robots debe mostrar la versión nueva con «Firma válida»; los robots se actualizan solos
cuando no tienen chats (§10).
