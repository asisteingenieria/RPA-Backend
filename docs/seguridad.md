# Seguridad del RPA de ventas (contexto)

Archivo de referencia **vivo**: cómo está protegida la solución hoy, qué ajustes existen, qué
reglas seguir al cambiar código y qué falta. Se actualiza con cada cambio de seguridad (sección
«Registro de cambios»).

Documentos relacionados:

- `docs/security-review.md`: informes de revisión con sus hallazgos (F8 del 06/10/2026 y la
  revisión del 04/11/2026, H1–H8).
- `docs/documentacionplan.md`: evidencias que pide Claro para la POC (7 requerimientos).
- `docs/runbook.md`: operación (§4 rotación de clave, §6 usuarios, §12.7 despliegue de los ajustes
  del 04/11/2026).
- `docs/planRPA.md` secciones 7 (reglas no negociables) y 8 (seguridad y protección de datos).

## 1. Superficie expuesta

| Componente                      | Expuesto a                                  | Por dónde                                                                                          |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| nginx (servidor 10.255.255.194) | Red interna                                 | 443 HTTPS: `/admin`, `/robot-api` (HTTP + WebSocket), `/health`, `/panel` y el panel `interfazRPA` |
| API (`apps/api`)                | Solo nginx                                  | `127.0.0.1:3000`                                                                                   |
| Worker (`apps/worker`)          | Nadie (no escucha)                          | Sale a Gemini por HTTPS                                                                            |
| PostgreSQL y Redis              | Solo el servidor (verificar con `ss -tlnp`) | Puertos locales                                                                                    |
| Robot (`apps/rpa`, PC)          | Nadie                                       | Sale a la pasarela (HTTPS/WSS) y a ySocial (HTTPS). `/health` solo en `127.0.0.1`                  |

Rutas sin autenticación: solo `/health` (sin datos personales) y, en la pasarela, `enroll` y
`token` (códigos de un solo uso y tokens de renovación, con bloqueo por intentos fallidos).

## 2. Controles por capa

### Red y transporte

- HTTPS en nginx. **Pendiente:** certificado de la CA de Claro (hoy autofirmado) y TLS 1.3
  verificado (runbook §12.7).
- `Strict-Transport-Security: max-age=31536000` (sin `includeSubDomains`). Los navegadores lo
  ignoran para hosts IP: aplica cuando el servidor tenga nombre.
- El robot confía en el certificado del servidor por `NODE_EXTRA_CA_CERTS`.

### API y panel

- Todos los controladores de `/admin` y `/admin/robots` llevan `AdminAuthGuard`; roles ADMIN y
  OPERADOR por ruta.
- Contraseñas con scrypt y sal; contraseña temporal con cambio obligatorio.
- Sesión en el servidor (`AdminSession`, solo el hash del token) con cookie `httpOnly`,
  `SameSite=Strict` y `Secure` (`ADMIN_COOKIE_SECURE`, por defecto `true`).
- Anti-CSRF: cabecera `x-requested-with: abaya-panel` en lo que cambia algo.
- Bloqueo por cuenta (5 fallos → 15 min) y por IP (10 fallos en 15 min → 15 min), con mensaje de
  error único que no revela si la cuenta existe.
- **IP real detrás de nginx:** `TRUST_PROXY` (por defecto `loopback`). Express toma la IP que
  agrega nginx al final de `X-Forwarded-For`; un valor falsificado por el cliente no gana. Sin
  esto, el bloqueo por IP era compartido por todos (H1).
- Cabeceras: CSP estricta (`default-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options:
DENY`, `nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, HSTS y sin
  `x-powered-by` (`apps/api/src/security-headers.ts`).
- Entradas validadas con zod; subidas con límite de tamaño y de archivos (`FileInterceptor`).
- Sin SQL armado a mano: Prisma parametrizado (el único `$executeRaw` usa plantilla).
- Páginas web de los Brains con `SafeWebFetcher` (protección SSRF).
- Auditoría de acciones del panel en `AdminAuditLog`.

### Pasarela de robots (`/robot-api/v1`)

- Token de acceso de 1 h (`ROBOT_ACCESS_TTL_MS`, HMAC) y token de renovación rotativo con
  detección de reúso (revoca y alerta `ROBOT_TOKEN_REUSE`).
- Cada operación verifica que los datos sean del robot del token (aislamiento entre robots).
- Límite de peticiones por robot y bloqueo por IP en `enroll`/`token`.
- WebSocket autenticado con el token de acceso; una conexión nueva del mismo robot reemplaza a la
  anterior.

### Robot (PC)

- `robot.json` protegido con DPAPI (token de renovación y clave local). El equipo nunca recibe la
  base de datos, Redis ni la clave de cifrado («hijo delgado»).
- La clave de ySocial se guarda cifrada en el servidor (`Robot.abayaPasswordEncrypted`) y nunca se
  devuelve al panel.
- Paquetes firmados con Ed25519; el robot verifica firma y SHA-256 antes de instalar y vuelve a la
  versión anterior si la nueva no arranca.
- `/health` solo en `127.0.0.1` (`RPA_LISTEN_HOST`; Docker usa `0.0.0.0`).
- Trazas solo en error, cifradas, 7 días (`TRACE_DIR`).
- El monitor en vivo (D-032) solo mira: no puede hacer clic ni escribir (`rule4.test.ts`); la
  pantalla no se guarda en disco.

### Datos personales

- Campos cifrados con AES-256-GCM (`packages/crypto`): mensajes, perfil, resumen de la venta,
  casos de servicio, respuesta del consentimiento, blobs de conocimiento. Rotación con
  `FIELD_ENCRYPTION_KEY_ID` y `FIELD_ENCRYPTION_PREVIOUS_KEYS` (runbook §4).
- Identificador del cliente guardado como hash (`customerRefHash`).
- Cadenas de hashes sin bifurcación en `ConsentEvidence` y `RpaActionLog`.
- Retención: `CONVERSATION_RETENTION_DAYS`. **Pendiente:** plazo de Claro (hoy vacío = no se
  borra).
- Trazabilidad (conversaciones completas) y monitor en vivo solo para ADMIN, auditados
  (`CONVERSATION_VIEWED`, `LIVE_VIEWED`, `SCREEN_VIEWED`).

### Logs y minimización hacia el LLM

- pino con redacción de campos sensibles (`REDACT_PATHS` en `packages/logger`).
- `scrubText` enmascara en textos libres **correos** (`[CORREO]`), **teléfonos** (`[TEL]`) y
  **números de documento** (`[NUM]`), en ese orden. Se aplica a los mensajes de log y a todo lo que
  se manda al LLM. Los datos de la venta los lee el código del mensaje original
  (`sale-data.ts`), no el modelo.

### Dependencias

- `pnpm audit --prod` debe dar 0 vulnerabilidades. Las transitivas se corrigen con `overrides` en
  `pnpm-workspace.yaml`, preferiblemente solo con subidas de parche (misma versión mayor).

## 3. Variables de configuración de seguridad

| Variable                                              | Por defecto | Para qué                                                                                                                       |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `TRUST_PROXY`                                         | `loopback`  | Proxies de confianza para la IP real. `false` = ninguno; número = saltos; `true` se trata como 1 (nunca confiar en cualquiera) |
| `RPA_LISTEN_HOST`                                     | `127.0.0.1` | Interfaz del `/health` del robot (`0.0.0.0` solo en Docker)                                                                    |
| `ADMIN_COOKIE_SECURE`                                 | `true`      | Cookie de sesión solo por HTTPS (`false` solo en desarrollo por HTTP)                                                          |
| `FIELD_ENCRYPTION_KEY` / `_KEY_ID` / `_PREVIOUS_KEYS` | —           | Cifrado de campos y rotación                                                                                                   |
| `CONVERSATION_RETENTION_DAYS`                         | vacío       | Borrado del contenido de conversaciones cerradas                                                                               |
| `ROBOT_ACCESS_TTL_MS`                                 | 1 h         | Vida del token de acceso del robot                                                                                             |
| `ROBOT_RELEASE_PUBLIC_KEY`                            | —           | Verificación de la firma de los paquetes del robot                                                                             |

Los secretos (`FIELD_ENCRYPTION_KEY`, `GEMINI_API_KEY`, `DATABASE_URL`, `ALERT_WEBHOOK_URL`) hoy
están en el `.env` del servidor (permisos 600). **Pendiente:** moverlos a una bóveda o al PAM de
Claro (requerimiento 6 de `documentacionplan.md`).

## 4. Reglas al cambiar código

1. Ruta nueva en la API → con `AdminAuthGuard` y rol; si es de la pasarela, verificar que los
   datos sean del robot del token. Ruta sin autenticación solo con justificación escrita aquí.
2. Nunca registrar datos personales: en logs solo ids y conteos; textos libres pasan por
   `scrubText`. Dato personal nuevo en la base → campo cifrado.
3. Lo que va al LLM pasa por `scrubText`; si el modelo necesita un dato, lo lee el código.
4. Dependencia nueva o actualización → `pnpm audit --prod` en 0.
5. Ningún ajuste de seguridad puede impedir que el robot arranque: valores por defecto seguros y
   tolerantes (ver `parseTrustProxy`), y despliegue fuera del horario del robot (07:00–22:00).
6. Cada cambio deja prueba automática, entra en `docs/security-review.md` si corrige un hallazgo y
   en el registro de abajo.

## 5. Pendientes

| Pendiente                                                        | Depende de        |
| ---------------------------------------------------------------- | ----------------- |
| Secretos del servidor en bóveda o PAM (H6)                       | Claro / proveedor |
| Certificado de la CA de Claro y TLS 1.3 verificado (H7)          | Servidor / Claro  |
| `X-Forwarded-For` en nginx (sin esto H1 no tiene efecto)         | Servidor          |
| Doble factor (TOTP) para ADMIN (H8)                              | Nosotros          |
| Plazo de retención de conversaciones                             | Claro             |
| Redis con contraseña y PostgreSQL con SSL si salen de la máquina | Servidor          |
| Llave de despliegue de GitHub de solo lectura                    | Servidor          |
| Certificado de firma de código para el instalador (SmartScreen)  | Asiste            |
| Pentest independiente, si Claro lo exige                         | Proveedor externo |

## 6. Registro de cambios

### 10/11/2026 — D-037: método `recovery.closeMissing` en la pasarela

El robot pide cerrar en la base las conversaciones que ya no están en su bandeja de Avaya. Mismo
esquema que `recovery.markNeedsReview` (máximo 500 ids, zod) y el repositorio solo cambia
conversaciones del robot del token que sigan abiertas (`robotUser` en el `where`): un robot no
puede cerrar conversaciones de otro. Sin datos personales en el log (solo el número de chats).

### 04/11/2026 — Preparación para un hacking ético básico

Hallazgos H1–H5 de `docs/security-review.md`, corregidos en código:

- **H1 IP real detrás de nginx.** `app.set('trust proxy', parseTrustProxy(config.TRUST_PROXY))`
  en `apps/api/src/main.ts`; variable `TRUST_PROXY` en `packages/config`. Corrige que unos
  intentos fallidos de cualquiera bloquearan el login del panel y la renovación de token de todos
  los robots. Requiere `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` en nginx;
  sin la cabecera se comporta como antes.
- **H2 Dependencias.** `overrides` de parche para `body-parser` (≥ 2.4.0), `multer` (≥ 2.5.0),
  `qs` (≥ 6.16.1) y `fast-uri` (≥ 3.1.9); `zod` ^4.6.6 en todos los paquetes. `pnpm audit --prod`:
  de 9 (3 altas) a 0.
- **H3 HSTS.** `Strict-Transport-Security: max-age=31536000` en `securityHeaders`.
- **H4 Correos enmascarados.** `EMAIL_RE` en `scrubText` (`packages/logger`), aplicado antes que
  teléfonos y documentos.
- **H5 `/health` del robot solo local.** `RPA_LISTEN_HOST` (por defecto `127.0.0.1`) en
  `packages/config` y en `localSettingsSchema` del robot hijo; `docker-compose.yml` pone `0.0.0.0`.

Pruebas: `apps/api/src/security-headers.test.ts` (IP real, IP falsificada, bloqueo por IP
separado, HSTS, valores de `TRUST_PROXY`) y `packages/logger/src/index.test.ts` (correos). Build,
typecheck, lint y pruebas en verde; suite de evaluación sin cambios (92/94, 0 inventados).
Despliegue sin afectar el horario del robot: runbook §12.7.
