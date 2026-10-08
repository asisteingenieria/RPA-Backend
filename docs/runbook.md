# Runbook de operación — Agente RPA de ventas en Abaya

> Para el equipo de operación. Panel: `https://<api>/panel` (usuario y contraseña personales; todo
> queda en la auditoría con tu usuario). Contactos en Claro: **[completar en el despliegue]**.

## 1. Apagado de emergencia (kill switch)

**Cuándo:** el robot escribe algo incorrecto, en el chat equivocado, o cualquier duda seria.

1. Panel → **Apagado de emergencia** → **Sí, detener**. Efecto inmediato: ninguna acción nueva sobre
   Abaya (enviar, nota, transferir, cerrar). La lectura de mensajes sigue, nada se pierde.
2. Alternativa sin panel: `redis-cli SET abaya:killswitch 1`.
3. Si Redis no responde, el robot **ya está detenido** (falla cerrado).
4. Para reanudar: Panel → **Reanudar robot** (solo rol ADMIN; un OPERADOR puede detener pero no
   reanudar). Los envíos pendientes se procesan en orden.
5. Revisar en el panel la sección **Requieren revisión humana** antes de reanudar.

## 2. Procedimiento por alerta (sección 11)

| Alerta                       | Severidad | Qué significa                                                                                                                                                     | Qué hacer                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_DOWN`               | Crítica   | El robot falló 3 logins seguidos y dejó de intentar (para no bloquear el usuario).                                                                                | 1) Entrar a mano a Abaya con el usuario robot desde la máquina del robot. 2) Si la contraseña expiró o el usuario está bloqueado: gestionar con Claro y actualizar el secreto. 3) Si hay MFA nuevo: revisar `ABAYA_MFA_MODE`/TOTP. 4) Panel → **Habilitar reintento** y reiniciar el proceso `rpa` de ese robot. |
| `HEARTBEAT_LOST`             | Crítica   | El robot no reporta hace más de 2 min (proceso caído o colgado).                                                                                                  | Ver estado del contenedor `rpa`; reiniciarlo. Al arrancar, reconcilia solo (reencola envíos y revisa la bandeja).                                                                                                                                                                                                |
| `ROBOT_DUPLICATE`            | Crítica   | Se intentó arrancar un robot en un segundo equipo mientras estaba en línea en otro (o el mismo robot quedó en dos equipos). El segundo no inicia sesión en Abaya. | 1) Panel → Robots: el aviso de la fila muestra los dos equipos. 2) Dejar el robot en un solo equipo: cerrar la ventana "Robot Abaya" en el sobrante y, si se instaló por error, `desinstalar.cmd`. 3) Si el robot debía pasar a otro equipo: apagar el viejo, **Reinstalar** en el panel e instalar en el nuevo. |
| `ROBOT_TOKEN_REUSE`          | Crítica   | Se presentó un token de renovación ya usado: copia del archivo `robot.json` o robo del equipo. El servidor ya revocó ese robot.                                   | 1) Ubicar el equipo legítimo del robot (panel → Robots). 2) Revisar quién tuvo acceso al equipo o a su carpeta. 3) Cambiar la contraseña de Abaya del robot (**Credenciales**). 4) **Reinstalar** con código nuevo en el equipo legítimo.                                                                        |
| `ROBOT_UPDATE_FAILED`        | Alta      | Una actualización no se instaló (firma o paquete inválido) o se instaló y no arrancó: el robot volvió solo a la versión anterior y sigue trabajando.              | 1) Panel → Robots: el estado ("Actualización fallida" / "Revertida") y su mensaje. 2) Firma inválida: revisar que el paquete se armó con la clave de publicación correcta. 3) Revertida: revisar la traza o los registros del equipo antes de volver a publicar. El robot no la reintenta solo.                  |
| `SELECTOR_BROKEN`            | Crítica   | 3 acciones seguidas fallidas: probable **cambio en la interfaz de Abaya**.                                                                                        | 1) Kill switch. 2) Abrir la traza del error (sección 5). 3) Actualizar `apps/rpa/src/abaya/selectors.ts` con fixtures nuevos sanitizados y pasar las pruebas. 4) Desplegar y reanudar.                                                                                                                           |
| `SALE_NOT_TRANSFERRED`       | Crítica   | Un cliente **autorizó** y su venta no llegó al backoffice en 5 min. **Es una venta en riesgo.**                                                                   | 1) Panel → revisión: ubicar el chat. 2) En Abaya: escribir la nota con el resumen (consultar con soporte técnico) y transferir a mano a la cola de backoffice. 3) Marcar la conversación como resuelta (soporte técnico).                                                                                        |
| `CONVERSATIONS_NEEDS_REVIEW` | Alta      | Hay conversaciones que el robot no puede continuar (proveedor LLM caído, transferencia incierta, chat desaparecido de la bandeja).                                | Atender cada una desde Abaya. Si el LLM estaba caído y ya volvió, soporte técnico puede reactivarla.                                                                                                                                                                                                             |
| `SEND_UNCERTAIN`             | Alta      | El robot envió un mensaje y no pudo confirmar que llegó. **No se reintenta solo.**                                                                                | Abrir el chat en Abaya: si el mensaje no está, escribirlo a mano o reactivar; si está, no hacer nada.                                                                                                                                                                                                            |
| `CUSTOMER_UNANSWERED`        | Alta      | Hay mensajes de clientes sin atender hace más de 2 min.                                                                                                           | Revisar el worker (logs, proveedor LLM) y la cola; si el robot está detenido, atender a mano.                                                                                                                                                                                                                    |
| `ROBOT_OVERLOADED`           | Alta      | Un robot tiene más chats abiertos que el tope (`MAX_CHATS_PER_ROBOT`, 3). Sus clientes esperan más.                                                               | 1) Panel → Robots: columna **Chats**. 2) Confirmar con Claro que Abaya limite a 3 chats por usuario robot. 3) Si es un pico puntual, vigilar la columna **Respuesta p95**; si persiste, agregar un robot (otro equipo).                                                                                          |
| `RESPONSE_SLOW`              | Alta      | El 95 % de las respuestas de un robot tardó más de 20 s en los últimos 15 min.                                                                                    | 1) Panel → Robots → **Ver**: ¿muchos chats abiertos, errores o acciones lentas (p95 de "Enviar mensaje")? 2) Si todas las acciones son lentas: red o equipo del robot (CPU/memoria) o Abaya lento. 3) Si solo el motor: revisar `LLM_PROVIDER_ERRORS` y el proveedor de respaldo.                                |
| `LLM_PROVIDER_ERRORS`        | Alta      | Más del 5 % de turnos fallan por el proveedor de IA en 10 min.                                                                                                    | Revisar el estado del proveedor. Si persiste: kill switch o cambiar `LLM_PROVIDER`/`LLM_MODEL` a la alternativa **evaluada** (regla 13) y reiniciar el worker.                                                                                                                                                   |
| `LLM_FALLBACK_RATE`          | Alta      | Más del 5 % de respuestas cayeron en respuesta segura en 1 h: posible degradación del modelo o del prompt.                                                        | Correr `pnpm evals -- --provider <actual>` y comparar con el último reporte; revertir el último cambio de prompt/modelo si empeoró.                                                                                                                                                                              |
| `SMOKE_TEST_FAILED`          | Alta      | La prueba de humo (cada 15 min) no pudo leer la bandeja.                                                                                                          | Igual que `HEARTBEAT_LOST`; si la sesión está activa pero la bandeja no se lee, tratar como `SELECTOR_BROKEN`.                                                                                                                                                                                                   |
| `CHATS_MISSING_FROM_INBOX`   | Alta      | Al reconciliar, chats abiertos en BD ya no están en la bandeja del robot (los movió un humano o expiraron).                                                       | Confirmar en Abaya quién los tiene; quedaron en revisión.                                                                                                                                                                                                                                                        |
| `CLOSE_UNCERTAIN`            | Alta      | Un cierre sin venta no se pudo confirmar.                                                                                                                         | Cerrar a mano en Abaya.                                                                                                                                                                                                                                                                                          |

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
