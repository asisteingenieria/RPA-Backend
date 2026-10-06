# Runbook de operación — Agente RPA de ventas en Abaya

> Para el equipo de operación. Panel: `https://<api>/panel` (token de administración + tu usuario,
> que queda en la auditoría). Contactos en Claro: **[completar en el despliegue]**.

## 1. Apagado de emergencia (kill switch)

**Cuándo:** el robot escribe algo incorrecto, en el chat equivocado, o cualquier duda seria.

1. Panel → **Apagado de emergencia** → **Sí, detener**. Efecto inmediato: ninguna acción nueva sobre
   Abaya (enviar, nota, transferir, cerrar). La lectura de mensajes sigue, nada se pierde.
2. Alternativa sin panel: `redis-cli SET abaya:killswitch 1`.
3. Si Redis no responde, el robot **ya está detenido** (falla cerrado).
4. Para reanudar: Panel → **Reanudar robot**. Los envíos pendientes se procesan en orden.
5. Revisar en el panel la sección **Requieren revisión humana** antes de reanudar.

## 2. Procedimiento por alerta (sección 11)

| Alerta                       | Severidad | Qué significa                                                                                                                      | Qué hacer                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_DOWN`               | Crítica   | El robot falló 3 logins seguidos y dejó de intentar (para no bloquear el usuario).                                                 | 1) Entrar a mano a Abaya con el usuario robot desde la máquina del robot. 2) Si la contraseña expiró o el usuario está bloqueado: gestionar con Claro y actualizar el secreto. 3) Si hay MFA nuevo: revisar `ABAYA_MFA_MODE`/TOTP. 4) Panel → **Habilitar reintento** y reiniciar el proceso `rpa` de ese robot. |
| `HEARTBEAT_LOST`             | Crítica   | El robot no reporta hace más de 2 min (proceso caído o colgado).                                                                   | Ver estado del contenedor `rpa`; reiniciarlo. Al arrancar, reconcilia solo (reencola envíos y revisa la bandeja).                                                                                                                                                                                                |
| `SELECTOR_BROKEN`            | Crítica   | 3 acciones seguidas fallidas: probable **cambio en la interfaz de Abaya**.                                                         | 1) Kill switch. 2) Abrir la traza del error (sección 5). 3) Actualizar `apps/rpa/src/abaya/selectors.ts` con fixtures nuevos sanitizados y pasar las pruebas. 4) Desplegar y reanudar.                                                                                                                           |
| `SALE_NOT_TRANSFERRED`       | Crítica   | Un cliente **autorizó** y su venta no llegó al backoffice en 5 min. **Es una venta en riesgo.**                                    | 1) Panel → revisión: ubicar el chat. 2) En Abaya: escribir la nota con el resumen (consultar con soporte técnico) y transferir a mano a la cola de backoffice. 3) Marcar la conversación como resuelta (soporte técnico).                                                                                        |
| `CONVERSATIONS_NEEDS_REVIEW` | Alta      | Hay conversaciones que el robot no puede continuar (proveedor LLM caído, transferencia incierta, chat desaparecido de la bandeja). | Atender cada una desde Abaya. Si el LLM estaba caído y ya volvió, soporte técnico puede reactivarla.                                                                                                                                                                                                             |
| `SEND_UNCERTAIN`             | Alta      | El robot envió un mensaje y no pudo confirmar que llegó. **No se reintenta solo.**                                                 | Abrir el chat en Abaya: si el mensaje no está, escribirlo a mano o reactivar; si está, no hacer nada.                                                                                                                                                                                                            |
| `CUSTOMER_UNANSWERED`        | Alta      | Hay mensajes de clientes sin atender hace más de 2 min.                                                                            | Revisar el worker (logs, proveedor LLM) y la cola; si el robot está detenido, atender a mano.                                                                                                                                                                                                                    |
| `LLM_PROVIDER_ERRORS`        | Alta      | Más del 5 % de turnos fallan por el proveedor de IA en 10 min.                                                                     | Revisar el estado del proveedor. Si persiste: kill switch o cambiar `LLM_PROVIDER`/`LLM_MODEL` a la alternativa **evaluada** (regla 13) y reiniciar el worker.                                                                                                                                                   |
| `LLM_FALLBACK_RATE`          | Alta      | Más del 5 % de respuestas cayeron en respuesta segura en 1 h: posible degradación del modelo o del prompt.                         | Correr `pnpm evals -- --provider <actual>` y comparar con el último reporte; revertir el último cambio de prompt/modelo si empeoró.                                                                                                                                                                              |
| `SMOKE_TEST_FAILED`          | Alta      | La prueba de humo (cada 15 min) no pudo leer la bandeja.                                                                           | Igual que `HEARTBEAT_LOST`; si la sesión está activa pero la bandeja no se lee, tratar como `SELECTOR_BROKEN`.                                                                                                                                                                                                   |
| `CHATS_MISSING_FROM_INBOX`   | Alta      | Al reconciliar, chats abiertos en BD ya no están en la bandeja del robot (los movió un humano o expiraron).                        | Confirmar en Abaya quién los tiene; quedaron en revisión.                                                                                                                                                                                                                                                        |
| `CLOSE_UNCERTAIN`            | Alta      | Un cierre sin venta no se pudo confirmar.                                                                                          | Cerrar a mano en Abaya.                                                                                                                                                                                                                                                                                          |

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

## 6. Cambiar prompts, modelo o catálogo

1. Cambiar en código (prompts) o cargar el catálogo nuevo: `pnpm --filter @abaya/worker seed -- <archivo>`.
2. **Regla 13:** correr `pnpm evals -- --provider <proveedor>`; meta 0 datos inventados y ≥ 95 %.
3. Adjuntar el reporte (`evals/reports/`) al cambio. Sin evaluación aprobada, no se despliega.

## 7. Lista de verificación de despliegue

- [ ] Autorización escrita de Claro y acuerdo de encargo de tratamiento de datos.
- [ ] Textos legales y catálogo **oficiales** cargados (hallazgos A3/A4 de `security-review.md`).
- [ ] Usuario robot dedicado (`robot-ventas-NN`), permisos mínimos, MFA resuelto.
- [ ] Secretos inyectados desde el gestor (no `.env` en la máquina): `ABAYA_PASSWORD`,
      `FIELD_ENCRYPTION_KEY`, `ADMIN_TOKEN` (≥ 32 caracteres aleatorios), claves del LLM.
- [ ] PostgreSQL con `sslmode=require` y usuario con permisos mínimos; `pnpm --filter @abaya/db migrate:deploy`.
- [ ] Redis con contraseña (y TLS si sale de la máquina).
- [ ] Red: el robot solo sale a Abaya y al proveedor del LLM; `/health` y `/panel` solo desde la red interna.
- [ ] Panel detrás de SSO corporativo (recomendado, hallazgo M3) y `trust proxy` configurado.
- [ ] `ALERT_WEBHOOK_URL` configurado y **cada alerta disparada a propósito una vez** (criterio F7).
- [ ] Proveedor LLM sin entrenamiento con los datos y con contrato que cubra la transferencia
      internacional (Ley 1581), o modelo en la nube contratada por Claro.
- [ ] Suite de evaluación aprobada con el proveedor y modelo finales.
- [ ] Piloto: 1 robot, horario limitado, revisión diaria de conversaciones con Claro.
