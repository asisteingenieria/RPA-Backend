# Informe del proyecto — Agente RPA de ventas en Abaya

> Fecha: 2026-10-08 · Fuente de verdad del diseño: `docs/planRPA.md` · Decisiones posteriores al
> plan: `docs/DECISIONS.md` (D-001 a D-005) · Operación: `docs/runbook.md` · Seguridad:
> `docs/security-review.md` · Panel: repositorio `interfazRPA`

## Contenido

1. [Resumen](#1-resumen)
2. [Objetivo y modelo de operación](#2-objetivo-y-modelo-de-operación)
3. [Arquitectura de despliegue: un servidor central y un robot por computador](#3-arquitectura-de-despliegue-un-servidor-central-y-un-robot-por-computador)
4. [¿Un robot puede atender varias conversaciones a la vez?](#4-un-robot-puede-atender-varias-conversaciones-a-la-vez)
5. [Estado del proyecto](#5-estado-del-proyecto)
6. [Backend](#6-backend)
7. [Frontend](#7-frontend)
8. [Tecnologías y por qué se eligieron](#8-tecnologías-y-por-qué-se-eligieron)
9. [Base de datos](#9-base-de-datos)
10. [Colas y workers](#10-colas-y-workers)
11. [Docker](#11-docker)
12. [Despliegue en el servidor (padre)](#12-despliegue-en-el-servidor-padre)
13. [Instalación en cada computador (robot hijo)](#13-instalación-en-cada-computador-robot-hijo)
14. [Evaluación del rendimiento por robot y por máquina](#14-evaluación-del-rendimiento-por-robot-y-por-máquina)
15. [Pendientes, riesgos y próximos pasos](#15-pendientes-riesgos-y-próximos-pasos)

---

## 1. Resumen

- El robot opera Abaya **como un asesor humano**: abre el navegador, inicia sesión con su propio
  usuario y contraseña, atiende los chats que Abaya le asigna, conduce la venta y la transfiere al
  backoffice con una nota interna.
- **Cada computador es un robot independiente**: su propio usuario de Abaya, su navegador, su
  sesión, su cola de acciones y sus métricas. Todos comparten un **servidor central** con la base
  de datos, las colas, el motor de conversación y el panel.
- **Servidor padre, robots hijos**: el servidor guarda las credenciales de cada robot (cifradas) y
  cada computador se instala con un paquete y un código de un solo uso, sin descargar el proyecto
  ni editar archivos. El panel muestra cuántos robots hay en línea, en qué equipo corre cada uno y
  su rendimiento.
- **Cada robot puede atender varias conversaciones a la vez** (como un asesor con varios chats
  abiertos). El tope lo pone Abaya (chats simultáneos por usuario, pendiente de Claro).
- **El agente se configura desde el panel** (v1.8): un guion en Markdown al estilo Dapta, con
  vista previa, prueba en un chat de simulación y versiones. **Publicar es inmediato** (D-005); la
  suite de evaluación corre después y queda como evidencia en el historial de cada versión. Cada
  conversación termina con la versión del guion con la que empezó (D-004).
- **Brains** (v1.9, D-001): el catálogo de planes y los documentos (texto, PDF, DOCX, páginas web)
  que consulta el agente, versionados y publicados desde el panel.
- **Trazabilidad** (D-002): el ADMIN ve las conversaciones reales completas, por robot, con
  búsqueda, rendimiento y exportación; cada apertura y exportación queda auditada.
- El flujo sigue el de la campaña en Dapta (D-003): menú 🅐–🅓, sin línea nueva, soporte que no
  cierra el chat y textos de transferencia y despedida de la campaña.
- Las fases F0–F8 están **construidas y probadas contra un Abaya simulado**. Para salir a
  producción faltan insumos externos: acceso a Abaya real, contenido comercial y legal de Claro,
  API keys del LLM y el servidor de despliegue.

## 2. Objetivo y modelo de operación

| Paso | Qué hace el robot                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------- |
| 1    | Abre Abaya en un navegador real (Chromium controlado por Playwright).                             |
| 2    | Inicia sesión con **su** usuario y contraseña de Abaya; mantiene la sesión y se reconecta si cae. |
| 3    | Detecta los chats asignados y los mensajes nuevos de los clientes.                                |
| 4    | Responde y conduce la venta (menú 🅐–🅓 → nombre y perfil → oferta → objeciones → autorización).    |
| 5    | Con el "SÍ AUTORIZO" del cliente: registra la venta y la evidencia de consentimiento.             |
| 6    | Deja la nota interna con el resumen y **transfiere el chat a la cola de backoffice** en Abaya.    |
| 7    | Cierra los chats que no son venta (no interesado, inactividad); a soporte le da los canales.      |

Para Abaya, cada robot es un asesor más con su usuario. El "cerebro" (qué responder) no está en el
computador del robot sino en el servidor central (sección 3).

**Principio de seguridad del negocio:** el código decide el flujo y pone los precios, planes y
textos legales desde el catálogo; el modelo de lenguaje solo redacta el texto conversacional y toda
su salida se valida antes de enviarse.

## 3. Arquitectura de despliegue: un servidor central y un robot por computador

```
                         ┌─────────────────── SERVIDOR CENTRAL ───────────────────┐
                         │  PostgreSQL   Redis   worker (motor)   api + panel     │
                         └───────▲───────────▲────────────────────────▲──────────┘
                                 │           │                        │ HTTPS
          ┌──────────────────────┼───────────┼──────────┐        navegador del
          │                      │           │          │        supervisor
   ┌──────┴──────┐        ┌──────┴──────┐        ┌──────┴──────┐
   │   PC-01     │        │   PC-02     │  ...   │   PC-10     │
   │ rpa         │        │ rpa         │        │ rpa         │
   │ robot-01    │        │ robot-02    │        │ robot-10    │
   │ Chromium    │        │ Chromium    │        │ Chromium    │
   └──────┬──────┘        └──────┬──────┘        └──────┬──────┘
          │                      │                      │
          └──────────────── Abaya (web) ────────────────┘
```

### 3.1 Qué corre en cada lugar

| Lugar                            | Procesos                                   | Responsabilidad                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Servidor central (padre)**     | `postgres`, `redis`, `worker`, `api`       | Datos, colas, motor de conversación (máquina de estados + LLM), ventas, alertas, panel, usuarios y **registro de robots** (credenciales cifradas, códigos de instalación, presencia). |
| **Cada computador (hijo)**       | `rpa` (uno solo), instalado con el paquete | Navegador, sesión en Abaya con su usuario, lectura de mensajes y ejecución de acciones en su pantalla. Recibe su configuración del padre al arrancar.                                 |
| **Navegador de quien supervisa** | —                                          | Panel (`interfazRPA`) en el servidor, con usuario y contraseña (ruta de publicación pendiente, 15.2).                                                                                 |

### 3.2 Qué hace independiente a cada robot ("bien seccionado")

Cada computador tiene **su propia identidad**, el usuario robot de Abaya (`ABAYA_USER`, por ejemplo
`robot-ventas-01`). Todo se separa por esa identidad:

| Elemento                      | Separación por robot                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Usuario y contraseña de Abaya | Uno por computador; **nunca el mismo usuario en dos computadores**.                                    |
| Navegador y sesión guardada   | Un Chromium por computador; la sesión se guarda cifrada en el disco de ese computador.                 |
| Conversaciones                | Cada `Conversation` guarda qué robot la atiende (`robotUser`).                                         |
| Cola de acciones              | `abaya.outbound.<robot>`, `abaya.transfer.<robot>`, `abaya.close.<robot>`: solo ese robot las consume. |
| Estado de la sesión           | Una fila por robot en `RpaSession` (activa, reconectando, caída).                                      |
| Equipo y presencia            | Una fila por robot en `Robot`: nombre del equipo, versión, encendido, última señal (cada 15 s).        |
| Pausa                         | Se puede pausar un robot sin afectar a los demás (bandera `abaya:pause:<robot>`).                      |
| Auditoría                     | Cadena de hashes propia por robot en `RpaActionLog`.                                                   |
| Salud                         | `/health` en el puerto `RPA_PORT` de cada computador.                                                  |

Consecuencia: si un computador se apaga o falla, **los demás robots siguen trabajando** y sus
conversaciones no se mezclan. Lo que comparten es el servidor central.

Cada robot registra **el nombre del equipo donde corre**, así que cada métrica por robot es una
métrica por máquina (sección 14). Igual se recomienda numerar a juego (`PC-01 ↔ robot-ventas-01`)
para que el personal los ubique fácil.

## 4. ¿Un robot puede atender varias conversaciones a la vez?

**Sí.** Un robot es como un asesor con varios chats abiertos:

| Etapa        | Simultaneidad                                  | Cómo                                                                                                                                                  |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leer**     | Todos los chats a la vez                       | Escucha el tráfico de red de Abaya (XHR/WebSocket) y, como respaldo, la pantalla. No hace clics para leer.                                            |
| **Pensar**   | Hasta 50 conversaciones en paralelo (servidor) | El `worker` procesa cada conversación con su propio estado en la base de datos. Probado con 20 simultáneas sin mezclar estados.                       |
| **Escribir** | Una acción a la vez por robot                  | Un navegador tiene una sola pantalla activa: abrir chat, verificar que es el correcto, escribir y enviar van en fila. Cada envío toma pocos segundos. |

Como el cliente tarda mucho más en contestar que el robot en enviar, un robot intercala varias
conversaciones sin que se note. Antes de cada escritura el robot **verifica en pantalla la
identidad del chat**; si hay duda, no escribe.

**Límites y supuestos:**

- El número máximo de chats simultáneos lo define Abaya por usuario (**pregunta 5 a Claro**).
- En el simulador los mensajes de todos los chats llegan por WebSocket. **Debe confirmarse en el
  Abaya real** (descubrimiento F1). Si Abaya solo muestra los mensajes del chat abierto, el robot
  rotará entre chats guiado por los indicadores de "no leído": seguirá atendiendo varios, algo más
  lento.
- Para más volumen se agregan **más robots (más usuarios y más equipos)**, no más concurrencia
  dentro de un mismo navegador.

### 4.1 Meta de operación: 3 chats por robot (v1.5)

| Mejora                       | Qué hace                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tope de 3 chats              | `MAX_CHATS_PER_ROBOT=3`; si un robot tiene más, sigue atendiendo pero alerta `ROBOT_OVERLOADED`. Pedir a Claro el mismo tope en Abaya.                                          |
| Prioridad en la fila         | Primero responder al cliente; luego abrir chat, transferir, leer la bandeja, cerrar y, al final, reciclar el navegador.                                                         |
| Tiempo de respuesta          | Desde que el robot detecta el mensaje del cliente hasta que Abaya confirma la respuesta. p50/p95 por robot en el panel; alerta `RESPONSE_SLOW` si el p95 de 15 min supera 20 s. |
| Motor                        | Timeout de 8 s con 1 reintento, _prompt caching_ y proveedor de respaldo opcional.                                                                                              |
| Barrido de mensajes perdidos | Cada 15 s: si un chat tiene no leídos y el sistema no tiene nada en curso para él, el robot lo abre y recupera el mensaje. Cubre cortes del WebSocket.                          |
| Reciclaje del navegador      | Cada 6 h, solo con la bandeja vacía y sin acciones pendientes, para que Chromium no se degrade.                                                                                 |
| Prueba de carga              | `pnpm loadtest`: N robots × 3 clientes simulados a la vez, con verificación de chat equivocado, duplicados y pérdidas.                                                          |

Criterio: 0 mensajes en chat equivocado, 0 duplicados, 0 perdidos, **p95 < 15 s** y p99 < 25 s.

## 5. Estado del proyecto

### 5.1 Avance por fase

| Fase                              | Estado | Detalle                                                                                                                                                                                                    |
| --------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0 Fundaciones                    | ✅     | Monorepo, CI, configuración, cifrado, logs con redacción, base de datos.                                                                                                                                   |
| F1 Descubrimiento de Abaya        | 🟡     | Selectores y parsers contra el **simulador**; falta el descubrimiento con Abaya real.                                                                                                                      |
| F2 Sesión                         | ✅     | Login, sesión cifrada, heartbeat, reconexión progresiva, MFA por TOTP. Probado en simulador.                                                                                                               |
| F3 Lectura de mensajes            | ✅     | Red + pantalla, huella única, sin duplicados.                                                                                                                                                              |
| F4 Envío                          | ✅     | `BrowserActor`, verificación de identidad del chat, kill switch, envíos inciertos nunca se reintentan solos.                                                                                               |
| F5 Motor de conversación          | ✅     | Máquina de estados, validadores anti-alucinación, adaptadores de LLM para Anthropic y OpenAI, suite de 69 casos. Flujo de la campaña (D-003). Catálogo y texto legal **sintéticos**.                       |
| F6 Venta y transferencia          | ✅     | Venta, consentimiento con cadena de hashes, nota y transferencia. Formato de nota pendiente de Claro.                                                                                                      |
| F7 Robustez, operación y panel    | ✅     | Colas por robot, reconciliación, alertas, trazas cifradas, prueba de humo, panel con usuarios y roles, robots padre/hijo con instalador y rendimiento por equipo. Falta la prueba de 8 h en ambiente real. |
| F8 Seguridad, despliegue y piloto | 🟡     | Revisión de seguridad y runbook hechos. Falta desplegar y el piloto.                                                                                                                                       |

Cambios posteriores a las fases (en `docs/planRPA.md` v1.8–v1.9 y `docs/DECISIONS.md`):

| Cambio                                       | Estado | Detalle                                                                                                                                                                    |
| -------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.8 Configuración del agente en el panel    | ✅     | Guion en Markdown, ajustes del modelo, revisión al guardar, «Probar agente» con el motor real, historial y restaurar.                                                      |
| v1.9 / D-001 Brains                          | ✅     | K1–K5: catálogo versionado, contexto completo, búsqueda híbrida (RAG) con PDF/DOCX y páginas web seguras. Publicar un Brain sigue exigiendo la evaluación.                 |
| D-002 Trazabilidad                           | ✅     | Conversaciones completas para ADMIN, búsqueda en el texto, rendimiento por robot, CSV, auditoría y retención configurable. Falta la referencia escrita de la autorización. |
| D-003 Flujo de la campaña (Dapta)            | ✅     | Menú 🅐–🅓, nombre antes de la oferta, soporte con canales sin cerrar, ofrecer asesor si no autoriza, textos de transferencia y despedida.                                   |
| D-004 Versiones del agente                   | ✅     | Nota del cambio, versión fijada por conversación, aplicar con urgencia a las conversaciones en curso, pruebas guardadas, diferencias del guion entre versiones.            |
| D-005 Publicar sin depender de la evaluación | ✅     | Publicar es inmediato con cualquier resultado; la evaluación corre después (o a pedido) y queda como evidencia. Reemplaza las reglas de publicación de D-004.              |

### 5.2 Calidad

- 475 pruebas automáticas en verde en el backend (2026-10-08): `worker` 158, `rpa` 93, `api` 85,
  `knowledge` 82, `crypto` 24, `domain` 13, `config` 7, `db` 6, `alerts` 3, `logger` 2,
  `robot-store` 2. Son unitarias, de integración con PostgreSQL real temporal y de navegador contra
  el Abaya simulado. El panel (`interfazRPA`) suma 13. La prueba «DOCX dañado» de `knowledge` falló
  una vez al correr todo el monorepo y pasa sola: sensible a la carga de la máquina.
- Suite de evaluación del motor: 69 conversaciones guionadas. Con el modelo heurístico de
  referencia cumple la meta (≥ 95 % de casos correctos y **0 datos inventados**). **Falta correrla
  con un LLM real** (requiere la API key en el servidor).
- CI: formato, lint, typecheck, pruebas y evaluación en cada cambio.

## 6. Backend

Tres procesos separados, para que una falla del navegador no detenga al motor (y viceversa) y para
poder tener **muchos robots con un solo motor**:

| Proceso  | Dónde corre     | Responsabilidad                                                                                                                                                                                                                                                                                   |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpa`    | Cada computador | Navegador, sesión en Abaya, lectura de mensajes, ejecución de acciones (`BrowserActor`), kill switch, verificación de chat, prueba de humo, trazas de error.                                                                                                                                      |
| `worker` | Servidor        | Agrupa ráfagas de mensajes (4 s), máquina de estados de la venta, llamadas al LLM, validadores, ventas y consentimiento, cierres por inactividad, alertas, outbox. Además: suite de evaluación del agente y de los Brains, «Probar agente», ingesta de documentos y retención de la Trazabilidad. |
| `api`    | Servidor        | Salud, panel de administración, usuarios y roles, kill switch, revisión de casos, auditoría, configuración y versiones del agente, Brains y Trazabilidad.                                                                                                                                         |

Paquetes compartidos: `domain` (reglas, eventos, configuración del agente y reglas del sistema),
`db` (esquema y cliente), `config` (variables validadas), `crypto` (cifrado, cadenas de hashes,
contraseñas, TOTP), `logger` (logs sin datos personales), `alerts`, `knowledge` (Brains: catálogo,
documentos, búsqueda y páginas web) y `robot-store`.

### 6.1 Rutas nuevas de la API (panel)

| Ruta                                                    | Qué hace                                                                                                                     | Rol                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `GET /admin/agent`, `POST /admin/agent/review`          | Configuración publicada y de trabajo, reglas del sistema, catálogo; revisión del guion mientras se escribe.                  | Ver: todos         |
| `PUT /admin/agent/draft`                                | Guarda un borrador (con nota; opcionalmente lanza la evaluación).                                                            | ADMIN              |
| `POST /admin/agent/draft/publish`                       | Publica al instante (D-005): nota opcional, urgencia y evaluación de evidencia después de publicar.                          | ADMIN              |
| `POST /admin/agent/versions/:id/evaluate`               | Evalúa cualquier versión para dejar la evidencia en su historial.                                                            | ADMIN              |
| `GET /admin/agent/versions`, `…/:id`, `…/:id/tests`     | Historial con resultado, conversaciones atendidas y pruebas guardadas; restaurar con `…/:id/restore`.                        | Ver: todos         |
| `POST /admin/agent/test`, `POST /admin/agent/tests`     | «Probar agente» (turno simulado con el motor real) y guardar la prueba en el historial.                                      | ADMIN (editor)     |
| `/admin/knowledge/…`                                    | Brains: fuentes, versiones, publicación con evaluación, prueba de consultas.                                                 | ADMIN para cambiar |
| `GET /admin/conversations`, `/stats`, `/:id`, `/export` | Trazabilidad: lista con filtros y KPIs, rendimiento por robot, detalle completo, CSV. Cada apertura y exportación se audita. | Solo ADMIN         |

## 7. Frontend

El panel es el repositorio **`interfazRPA`** (React 19 + Vite + Tailwind v4 + shadcn/ui +
TanStack Router y Query), con el kit visual de Asiste ING (skill `asiste-agente-rpa-ui`). Habla
con la `api` por `/admin/*` en el mismo origen (cookie de sesión). En desarrollo corre en
`http://localhost:5180` y reenvía `/admin` a la `api`. El panel anterior (`apps/panel`, servido en
`/panel`) queda reemplazado.

| Pantalla         | Qué muestra                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inicio y En vivo | Estado de cada robot, conversaciones activas, ventas del día y transferidas, casos para revisión humana, envíos inciertos y errores recientes.                                                         |
| Robots           | Cuántos hay en línea, equipo, estado, versión, rendimiento por rango de fechas, historial de acciones, alta con código de instalación, pausa, credenciales y descarga del instalador.                  |
| Agente           | Pestañas Configuración (guion con vista previa, ajustes, prueba al lado), Probar agente, Historial, Evaluaciones y Conocimiento (Brains). Detalle en 7.1.                                              |
| Trazabilidad     | Conversaciones reales completas por robot: filtros (rango, robot, tipificación, proceso, etapa, revisión, versión del guion), búsqueda en el texto, detalle con anterior/siguiente, rendimiento y CSV. |
| Usuarios         | Alta, rol, bloqueo y contraseñas temporales (ADMIN).                                                                                                                                                   |
| Auditoría        | Acciones del panel y por quién (ADMIN).                                                                                                                                                                |

El apagado de emergencia (kill switch) está siempre visible; reanudar es solo del ADMIN.

Roles: **ADMIN** (todo, incluida la Trazabilidad) y **OPERADOR** (consulta, revisión, apagado de
emergencia y probar la versión publicada). Lo que el OPERADOR no puede hacer se ve deshabilitado
con el motivo.

### 7.1 Agente: guion, versiones y publicación (D-004, D-005)

- **Guion:** un bloque en Markdown organizado por etapas (`## MENU`, `## PERFIL`, `## OFERTA`,
  `## OBJECIONES`, `## AUTORIZACION`). Va siempre detrás de las **reglas del sistema**, que no se
  editan y mandan si el guion las contradice. El menú, la autorización, los precios y los textos
  legales los pone el código.
- **Revisión al guardar:** el guion no puede llevar precios, gigas ni porcentajes (salen del
  catálogo); la bienvenida no admite promesas prohibidas ni enlaces.
- **Guardar borrador:** guarda sin publicar, con una nota del cambio opcional.
- **Publicar:** inmediato, pase o no la evaluación. Si el editor tiene cambios, se guardan como
  versión nueva y esa se publica. Opciones: nota, «Evaluar después de publicar» (marcada por
  defecto) y «Aplicar también a las conversaciones en curso (urgencia)».
- **Evaluación como evidencia:** la suite (69 conversaciones guionadas; meta 0 datos inventados y
  ≥ 95 % de casos correctos) corre en segundo plano después de publicar o con «Evaluar» desde el
  historial. Su resultado (OK, con alertas, inventó datos, error) queda en la versión, con la
  conversación de cada caso fallido. Nunca publica ni despublica.
- **Versión por conversación:** cada conversación termina con la versión del guion con la que
  empezó; las nuevas usan la publicada. Con urgencia, las abiertas pasan a la nueva.
- **Historial:** por versión, nota, quién guardó y publicó, resultado de la evaluación,
  conversaciones reales atendidas (enlace a la Trazabilidad filtrada), pruebas guardadas y qué
  cambió en el guion frente a la versión anterior.
- **Protección en producción:** con o sin evaluación, cada respuesta real pasa por los validadores
  (sin cifras fuera de las fichas del catálogo, sin promesas prohibidas, sin planes inexistentes,
  máximo dos planes por mensaje). Si una respuesta falla, el modelo la rehace una vez y, si vuelve
  a fallar, sale una frase segura.

### 7.2 Trazabilidad (D-002)

- Claro autoriza mostrar el contenido de las conversaciones reales sin enmascarar, para seguir el
  rendimiento de cada robot. **Falta adjuntar la referencia del documento escrito** en D-002.
- Solo ADMIN. El contenido se descifra solo para la respuesta HTTP y nunca va a los logs.
- La búsqueda incluye el texto de los mensajes (rango máximo 30 días con búsqueda). El CSV de la
  lista no lleva texto; la transcripción se exporta por conversación.
- **Retención:** `CONVERSATION_RETENTION_DAYS` (vacío = no se borra). Una tarea horaria borra el
  contenido de las conversaciones cerradas vencidas y conserva tipificación, venta y métricas. El
  plazo lo define Claro.
- Datos que hoy no existen y se muestran como «—»: teléfono del cliente, origen exacto de cada
  respuesta, recorrido completo de etapas y lo que pasa después de la transferencia.

## 8. Tecnologías y por qué se eligieron

| Tecnología                       | Uso                        | Por qué                                                                                                                                                      |
| -------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **TypeScript** sobre Node.js     | Todo el código             | Un solo lenguaje para robot, motor, API y panel; tipos estrictos que evitan errores.                                                                         |
| **Playwright** (Chromium)        | Operar Abaya               | Esperas automáticas, lectura de red y WebSocket, sesión persistente y trazas. Más estable que Selenium y más barato y determinista que leer capturas con IA. |
| **NestJS**                       | Estructura de los procesos | Módulos e inyección de dependencias: cada pieza se reemplaza o se simula en pruebas.                                                                         |
| **PostgreSQL** + **Prisma**      | Base de datos              | Transacciones y restricciones únicas que impiden duplicar mensajes o ventas. Prisma da tipos y migraciones versionadas.                                      |
| **Redis** + **BullMQ**           | Colas y banderas           | Una cola de acciones por robot, reintentos controlados y kill switch compartido en caliente.                                                                 |
| **zod**                          | Validación                 | Configuración, datos de Abaya y salidas del LLM se validan antes de usarse.                                                                                  |
| **LLM por API directa**          | Redactar respuestas        | Proveedor intercambiable (adaptadores de Anthropic y OpenAI; Gemini previsto) y elegido con datos de la suite de evaluación.                                 |
| **pino**                         | Logs                       | Redacción automática de teléfonos, nombres y contenido.                                                                                                      |
| **Vitest** + **Playwright Test** | Pruebas                    | Unitarias, integración con PostgreSQL real temporal y navegador contra el simulador.                                                                         |
| **pnpm** + **Turborepo**         | Monorepo                   | Varios procesos y paquetes en un repositorio, con compilación incremental.                                                                                   |
| **React** + **Vite**             | Panel (`interfazRPA`)      | Con Tailwind, shadcn/ui y TanStack Router/Query. Habla con la API en el mismo origen (sin CORS).                                                             |
| **Docker**                       | Empaquetado y despliegue   | Cada proceso con sus dependencias exactas (incluido el Chromium fijado); corre igual en cualquier máquina.                                                   |

## 9. Base de datos

**Motor:** PostgreSQL (17 en Docker; 18 en el ambiente local de desarrollo). Esquema en
`packages/db/prisma/schema.prisma`, migraciones en `packages/db/prisma/migrations/`. Los contenidos
sensibles (mensajes, perfil del cliente, resúmenes, respuesta de consentimiento) se guardan
**cifrados** (AES-256-GCM con rotación de clave).

| Tabla                                               | Para qué sirve                                                                                                                                                                                                         | Separada por robot      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `Conversation`                                      | Cada chat de Abaya: paso de la venta, estado, robot que lo atiende, perfil del cliente (cifrado), versión del guion con la que empezó (`agentVersionId`) y si se borró su contenido por retención (`contentPurgedAt`). | Sí (`robotUser`)        |
| `Message`                                           | Mensajes entrantes y salientes (cifrados), huella anti-duplicados y estado del envío (pendiente, verificado, incierto).                                                                                                | Vía la conversación     |
| `Sale`                                              | Venta: proceso, plan, resumen para el backoffice (cifrado), hora de transferencia.                                                                                                                                     | Vía la conversación     |
| `ConsentEvidence`                                   | Prueba de la autorización del cliente: hash del texto mostrado, respuesta, hora de Bogotá; cadena de hashes inalterable.                                                                                               | Vía la conversación     |
| `RpaSession`                                        | Estado de la sesión de cada robot en Abaya y su último heartbeat.                                                                                                                                                      | Sí (una fila por robot) |
| `RpaActionLog`                                      | Auditoría de cada acción del robot (abrir chat, enviar, nota, transferir, cerrar), con duración y resultado; cadena de hashes por robot.                                                                               | Sí (`robotUser`)        |
| `Plan`                                              | Catálogo de planes y precios: única fuente de esos datos.                                                                                                                                                              | No (compartido)         |
| `PromptVersion`                                     | Histórico: instrucciones por paso de la venta anteriores a la v1.8.                                                                                                                                                    | No                      |
| `AgentConfigVersion`                                | Versiones del agente: guion, ajustes, estado (borrador, publicada, archivada), nota del cambio, resultado de la evaluación (`evalVerdict`, evidencia), quién publicó, nota y urgencia.                                 | No                      |
| `AgentTestRecord`                                   | Pruebas de «Probar agente» guardadas en el historial de una versión (solo simulación).                                                                                                                                 | No                      |
| `Brain`, `BrainVersion`, `AgentBrain`               | Bases de conocimiento, sus versiones (borrador, evaluando, publicada) y a qué agente están conectadas.                                                                                                                 | No                      |
| `KnowledgeSource`, `KnowledgeBlob`, `CatalogRecord` | Fuentes de cada Brain (texto, archivo, página web), el archivo original y los registros del catálogo de planes.                                                                                                        | No                      |
| `SourceChunk`, `VersionChunk`, `KnowledgeUsage`     | Fragmentos para la búsqueda (RAG), los que entran en cada versión y qué conocimiento se usó en cada turno.                                                                                                             | No                      |
| `LlmCall`                                           | Trazabilidad de cada llamada al modelo: proveedor, latencia, tokens, resultado de la validación.                                                                                                                       | Vía la conversación     |
| `OutboxEvent`                                       | Eventos (venta lista, transferida, cerrada) guardados con la operación y publicados después; no se pierden si algo cae.                                                                                                | No                      |
| `AdminAuditLog`                                     | Acciones hechas desde el panel y por quién.                                                                                                                                                                            | No                      |
| `AdminUser`                                         | Usuarios del panel (contraseña con hash, rol, bloqueo).                                                                                                                                                                | No                      |
| `Robot`                                             | Registro de robots hijos: credenciales de Abaya cifradas, código de instalación y token del equipo (como hash), equipo, versión, presencia, pausa.                                                                     | Sí (una fila por robot) |
| `AdminSession`                                      | Sesiones abiertas del panel.                                                                                                                                                                                           | No                      |

## 10. Colas y workers

Redis + BullMQ conectan los procesos:

| Cola                         | Quién produce → quién consume | Para qué                                                                                      |
| ---------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `abaya.inbound`              | cada `rpa` → `worker`         | Mensajes nuevos de los clientes.                                                              |
| `abaya.outbound.<robot>`     | `worker` → ese `rpa`          | Respuestas a enviar. Concurrencia 1: una acción a la vez por navegador.                       |
| `abaya.transfer.<robot>`     | `worker` → ese `rpa`          | Nota interna + transferencia al backoffice.                                                   |
| `abaya.close.<robot>`        | `worker` → ese `rpa`          | Cierres sin venta.                                                                            |
| `abaya.evals`                | `api` → `worker`              | Evaluación de una versión del agente (evidencia, D-005) o de un Brain.                        |
| `abaya.agent-test`           | `api` → `worker`              | «Probar agente»: un turno del motor real con respuesta inmediata; no toca Abaya.              |
| `abaya.knowledge-ingest`     | `api` → `worker`              | Procesar las fuentes de un Brain (extraer texto, fragmentar, indexar).                        |
| `abaya:killswitch` (bandera) | `api` → todos los `rpa`       | Apagado de emergencia en caliente. Si Redis no responde, el robot se detiene (falla cerrado). |

Tareas programadas: cierre por inactividad, alertas, limpieza y retención de la Trazabilidad cada
hora (en el `worker`); prueba de humo cada 15 min y limpieza de trazas (en cada `rpa`).

## 11. Docker

Cada proceso tiene su `Dockerfile` (`apps/rpa`, `apps/worker`, `apps/api`). La imagen del robot usa
la imagen oficial de Playwright con el **Chromium de la versión fijada**, así que el navegador es
idéntico en todas las máquinas.

- **En el servidor:** Docker Compose levanta PostgreSQL, Redis, `worker` y `api` (sección 12).
- **En cada computador:** no hace falta Docker. El robot se instala con el paquete para Windows
  (`abaya-robot-windows.zip`), que trae Node.js y el navegador, y puede verse trabajando en
  pantalla (sección 13). La imagen Docker del robot queda para servidores Linux sin pantalla.
- **En desarrollo:** hoy no hay Docker en la máquina de desarrollo; se usa PostgreSQL local y los
  procesos con `pnpm`.

## 12. Despliegue en el servidor (padre)

### 12.1 Requisitos

| Recurso        | Recomendado (10 robots)                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sistema        | Linux (Ubuntu Server 24.04) con Docker y Docker Compose                                                                                               |
| CPU / RAM      | 4 vCPU / 8 GB                                                                                                                                         |
| Disco          | 50 GB SSD (base de datos y respaldos)                                                                                                                 |
| Red de entrada | **Solo HTTPS (443)**: los computadores robot hablan únicamente con la pasarela (v1.6); la red interna usa el panel. PostgreSQL y Redis no se exponen. |
| Red de salida  | Proveedor del LLM y webhook de alertas.                                                                                                               |

El servidor **no necesita** acceso a Abaya: quienes entran a Abaya son los computadores robot.

### 12.2 Pasos

1. **Instalar Docker** y Docker Compose en el servidor.
2. **Copiar el proyecto** (repositorio) al servidor.
3. **Secretos**: crear el archivo de entorno del servidor desde `.env.example` con valores del
   gestor de secretos. Variables del servidor:

   | Variable                             | Valor                                                                                            |
   | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
   | `NODE_ENV`                           | `production`                                                                                     |
   | `POSTGRES_PASSWORD`                  | contraseña larga y aleatoria                                                                     |
   | `FIELD_ENCRYPTION_KEY`               | 32 bytes en base64 (`openssl rand -base64 32`). El servidor la entrega a cada robot al arrancar. |
   | `ABAYA_BASE_URL`                     | URL de Abaya que usarán todos los robots                                                         |
   | `ROBOT_ACCESS_TTL_MS`                | Vida del token de acceso de los robots (por defecto 1 h; solo bajarlo para pruebas)              |
   | `ROBOT_PACKAGE_FILE`                 | Ruta del instalador `abaya-robot-windows.zip` que el panel ofrece para descargar                 |
   | `LLM_PROVIDER`, `LLM_MODEL`, API key | proveedor y modelo elegidos con la suite de evaluación                                           |
   | `ALERT_WEBHOOK_URL`                  | webhook de Slack/Teams                                                                           |
   | `ADMIN_COOKIE_SECURE`                | `true` (obligatorio en producción)                                                               |
   | `INACTIVITY_MINUTES`                 | `120` (o lo que defina Claro)                                                                    |

4. **Levantar solo los servicios centrales** (el `rpa` corre en los computadores, no en el
   servidor):

   ```bash
   docker compose up -d postgres redis
   ```

5. **Aplicar las migraciones** de la base de datos:

   ```bash
   pnpm install --frozen-lockfile && pnpm db:generate
   pnpm --filter @abaya/db migrate:deploy
   ```

6. **Cargar el catálogo oficial** de planes (cuando Claro lo entregue):

   ```bash
   pnpm --filter @abaya/worker seed -- <archivo-de-planes.json>
   ```

7. **Levantar el motor y la API**:

   ```bash
   docker compose up -d worker api
   ```

8. **Crear el primer administrador del panel** (imprime una contraseña temporal una sola vez):

   ```bash
   pnpm --filter @abaya/api create-admin -- <usuario>
   ```

9. **Armar el instalador de los robots** (en una máquina Windows con el repositorio) y copiarlo a
   la ruta de `ROBOT_PACKAGE_FILE`:

   ```bash
   pnpm robot:package                  # el navegador se descarga al instalar
   pnpm robot:package --con-navegador  # incluye Chromium (equipos sin Internet)
   ```

10. **Publicar el panel y `/robot-api` por HTTPS** con un proxy inverso (nginx, Caddy o el
    balanceador de la empresa) hacia el puerto 3000. No exponer el 3000 directamente.
11. **Firewall**: solo 443 (HTTPS) hacia el servidor, desde la red interna y los computadores
    robot. PostgreSQL y Redis quedan cerrados al exterior del servidor. Redis con contraseña (`requirepass`) y PostgreSQL con TLS (`sslmode=require`).
12. **Verificar**: `curl https://<servidor>/health` y entrar al panel (hoy `https://<servidor>/panel`; ver 15.2).
13. **Respaldos**: `pg_dump` diario de la base `abaya_rpa`, guardado fuera del servidor.

> El `docker-compose.yml` actual está pensado para desarrollo (un solo robot, Redis sin
> contraseña, puertos abiertos). Antes del despliegue hay que preparar un
> `docker-compose.server.yml` con lo anterior (ver sección 15).

## 13. Instalación en cada computador (robot hijo)

Cada computador es un **robot hijo**: corre un solo proceso `rpa` con su propio usuario de Abaya.
**No se descarga el proyecto ni se edita ningún `.env`**: se instala con un paquete y un código.

### 13.1 Cómo funciona padre ↔ hijo (v1.6: "hijo delgado")

El equipo robot **solo habla con el servidor por HTTPS**: no recibe la conexión a la base de
datos, a Redis ni la clave de cifrado. El servidor guarda y cifra todo; al equipo le entrega por
TLS solo el texto de **sus** mensajes y le empuja sus tareas (enviar, transferir, cerrar) y el
estado del kill switch por un WebSocket. Cada robot solo puede tocar sus propios chats.

**Tokens:** el equipo usa un token de acceso de 1 hora que **renueva solo en segundo plano**
(a los 50 minutos), sin cortar conversaciones ni ventas en curso; si la renovación falla, deja
de actuar en Abaya hasta lograrla (no se pierde nada). El token de renovación está protegido
con DPAPI (usuario de Windows) y **cambia en cada renovación**: si una copia vieja se usa, el
servidor revoca el robot y alerta. Probado con tokens de 60 s durante 5 minutos de carga:
0 errores, 0 mensajes perdidos, p95 igual que en modo directo.

```
 PANEL (ADMIN)                     SERVIDOR (padre)                    COMPUTADOR (hijo)
 1. Agregar robot  ──────────────▶ guarda usuario + contraseña de
    (usuario y clave de Abaya)     Abaya CIFRADOS y genera un código
                                   de un solo uso (24 h)
 2. Copia el código  ─────────────────────────────────────────────────▶ instalar.cmd
                                                                        (servidor + código)
                                   cambia el código por un token  ◀──── 3. registra el equipo
                                   del equipo (revocable)               guarda robot.json
                                                                        (servidor + token)
                                   entrega la configuración       ◀──── 4. en CADA arranque
                                   (solo usuario y clave de Abaya)      (solo en memoria)
                                   registra equipo, versión,      ◀──── 5. reclama el robot y
                                   presencia cada 15 s                  reporta presencia
```

El equipo **nunca guarda la contraseña de Abaya**. Si se cambia en el panel, el robot la toma en
su siguiente arranque. Si se deshabilita el robot en el panel, el equipo se apaga solo en menos de
15 segundos y no puede volver a arrancar sin un código nuevo.

### 13.2 Requisitos del computador

- Windows 10/11 con un usuario de Windows que permanezca con sesión iniciada (el robot corre en
  esa sesión, como lo haría un asesor).
- 4 GB de RAM libres y conexión estable.
- Acceso de red a **Abaya** (VPN o red de Claro si aplica) y al **servidor** (solo HTTPS).
- **No necesita** Node.js, Git ni el proyecto: el paquete trae todo.

### 13.3 Pasos (unos 5 minutos por equipo)

1. **En el panel** (rol ADMIN) → pestaña **Robots** → **Agregar robot**: usuario y contraseña de
   Abaya de ese equipo (y secreto TOTP si Abaya pide MFA). El panel muestra un **código de
   instalación** (por ejemplo `HMYG-XVTT-QSDT`), válido una vez y por 24 h.
2. **En el computador**: abrir el panel en el navegador y pulsar **Descargar instalador**
   (`abaya-robot-windows.zip`, unos 80 MB), o copiarlo con una USB. Descomprimirlo.
3. Doble clic en **`instalar.cmd`** y escribir:
   - la dirección del servidor (por ejemplo `https://rpa.empresa.com`);
   - el código de instalación.
4. El instalador:
   - copia el robot a `%LOCALAPPDATA%\AbayaRobot` (con Node.js y el navegador incluidos);
   - registra el equipo en el servidor con el código;
   - deja la carpeta legible solo por ese usuario de Windows;
   - crea el acceso para que **arranque solo al iniciar sesión en Windows**;
   - inicia el robot.
5. En el panel, el robot aparece **En línea** con el nombre del equipo en menos de un minuto.

Opciones: `instalar.cmd -SinVentana` (navegador oculto) y
`instalar.cmd -Servidor <url> -Codigo <código>` (sin preguntas, para instalar en muchos equipos).

### 13.4 Actualizaciones (v1.7)

Las versiones nuevas se publican una vez en el servidor y se aplican **desde el panel**, sin ir a
los equipos. Cada paquete va **firmado** con una clave propia (Ed25519); cada robot verifica la
firma y el SHA-256 antes de instalar. El robot descarga en segundo plano, **espera a tener la
bandeja vacía** (no interrumpe ventas), se reinicia en la versión nueva y la confirma a los 2
minutos; si no arranca, **vuelve solo a la anterior** y alerta. En cada equipo quedan las
versiones lado a lado (`versions\`). Hay además un botón local (`actualizar.cmd`).

Prueba real en este equipo: instalación de la versión 1, actualización a la 2 desde la API del
panel (17 s fuera de línea, confirmada a los 2 min) y una versión 3 rota, firmada, revertida
automáticamente a la 2 en 11 s con el reporte "Revertida" en el panel.

### 13.5 Operación diaria

| Necesidad                      | Cómo                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detener el robot de un equipo  | Cerrar la ventana "Robot Abaya" (se apaga en orden y queda "Apagado" en el panel).                                                                                                 |
| Volver a iniciarlo             | `%LOCALAPPDATA%\AbayaRobot\iniciar.cmd` o cerrar y abrir sesión en Windows.                                                                                                        |
| Pausar sin apagar              | Panel → Robots → **Pausar** (no ejecuta acciones en Abaya hasta **Reanudar**).                                                                                                     |
| Si se cae el proceso           | El lanzador lo reinicia solo a los 30 s.                                                                                                                                           |
| Cambiar la contraseña de Abaya | Panel → **Credenciales**; el robot la usa en su siguiente arranque.                                                                                                                |
| Actualizar a una versión nueva | Panel → **Actualizar** (o **Actualizar todos**). El robot se actualiza solo cuando no tiene chats, verifica la firma y vuelve a la versión anterior si la nueva no arranca (v1.7). |
| Cambiar el robot de equipo     | Apagar el equipo viejo, **Reinstalar** y ejecutar el instalador en el equipo nuevo.                                                                                                |
| Retirar un equipo              | `desinstalar.cmd` en el equipo y **Deshabilitar** en el panel.                                                                                                                     |

### 13.6 Reglas que el sistema hace cumplir

- **Un usuario de Abaya = un equipo a la vez.** Si se arranca el mismo robot en un segundo equipo
  mientras el primero está en línea, el segundo **no inicia sesión en Abaya**, se dispara la alerta
  crítica `ROBOT_DUPLICATE` y el panel muestra el aviso con el nombre de los dos equipos.
- Si un equipo se apaga sin aviso (corte de luz), otro puede tomar el robot después de 1 minuto
  sin presencia.
- Robot deshabilitado o instalación revocada: el equipo se niega a arrancar y el lanzador no
  insiste (muestra el motivo en la ventana).

### 13.7 Modo desarrollo

Para desarrollo y la demo se sigue pudiendo correr el robot con `.env` (`pnpm --filter @abaya/rpa
start`); en ese modo el robot también se registra y aparece en la pestaña Robots.

### 13.8 Prueba realizada (2026-10-06)

Se probó el ciclo completo con el **paquete real** contra el servidor y Abaya simulados:

1. ADMIN crea el robot en la API y recibe el código.
2. Se descomprime el zip y se ejecuta `instalar.ps1` con el código: el equipo queda registrado.
3. `iniciar.cmd` arranca el robot: recibe su configuración del servidor, se registra con el nombre
   del equipo y la versión, inicia sesión en Abaya y aparece **En línea** en el panel.
4. Un segundo equipo con el mismo robot es **rechazado** (código 3) y el panel muestra el aviso.
5. Al **pausar** y **deshabilitar** desde el panel con el robot en marcha, el hijo se apaga solo y
   la instalación queda revocada.
6. Reinstalación sobre la misma carpeta con un código nuevo.

## 14. Evaluación del rendimiento por robot y por máquina

Cada robot registra **en qué equipo corre** (nombre de Windows), su versión, cuándo arrancó y su
última señal. Así, **todo lo que se mide por robot se mide por máquina**, sin depender de una
convención de nombres.

### 14.1 Pestaña "Robots" del panel

**Tabla comparativa** (Hoy / 7 días / 30 días), una fila por robot:

| Columna             | Qué indica del equipo                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Equipo, versión     | Dónde corre y con qué versión del instalador                                               |
| Estado              | En línea · Reconectando · Caído (login) · Sin señal · Apagado · Deshabilitado, y "Pausado" |
| Última señal        | Hace cuánto reportó presencia (cada 15 s)                                                  |
| Conversaciones      | Volumen atendido                                                                           |
| Ventas, conversión  | Resultado comercial                                                                        |
| Envío p95           | Velocidad del equipo, su red y Abaya al enviar mensajes                                    |
| Errores / inciertos | Estabilidad del equipo                                                                     |

Arriba: robots registrados, **cuántos están en línea ahora**, cuántos caídos o sin señal y ventas
del rango. Si alguien intenta abrir un robot en un segundo equipo, aparece un aviso en su fila.

**Detalle de cada robot** (botón **Ver**): equipo, encendido desde, versión, fecha de instalación,
estado de la sesión en Abaya, conversaciones por resultado, **rendimiento por acción** (abrir
chat, enviar, nota, transferir, cerrar: total, OK, errores, inciertas, bloqueadas, p50 y p95) e
**historial de las últimas 100 acciones** con hora, chat, resultado y duración.

Permisos: ambos roles ven los robots y su rendimiento; solo ADMIN crea, pausa, reinstala,
cambia credenciales y deshabilita.

### 14.2 Fuentes de los datos

| Métrica                             | De dónde sale                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| Equipo, versión, presencia          | `Robot` (`host`, `version`, `startedAt`, `lastSeenAt`, `state`)                |
| Conversaciones y resultado          | `Conversation.robotUser`, `status`                                             |
| Ventas y transferidas               | `Sale` ↔ `Conversation.robotUser`                                              |
| Duración y resultado de cada acción | `RpaActionLog` (`robotUser`, `action`, `result`, `durationMs`)                 |
| Sesión en Abaya                     | `RpaSession`                                                                   |
| Latencia del modelo (común a todos) | `LlmCall` (sirve para separar "lento por la máquina" de "lento por el modelo") |

### 14.3 Consultas SQL para análisis propios

**Resumen del día por robot y equipo:**

```sql
SELECT c."robotUser", r.host AS equipo,
       count(*)                                                    AS conversaciones,
       count(s.id)                                                 AS ventas,
       count(s."transferredAt")                                    AS transferidas,
       round(100.0 * count(s.id) / nullif(count(*), 0), 1)         AS conversion_pct,
       count(*) FILTER (WHERE c.status = 'NEEDS_REVIEW')           AS en_revision
FROM "Conversation" c
LEFT JOIN "Sale" s ON s."conversationId" = c.id
LEFT JOIN "Robot" r ON r."robotUser" = c."robotUser"
-- Las fechas se guardan en UTC: inicio del día de Bogotá expresado en UTC.
WHERE c."createdAt" >= (date_trunc('day', now() AT TIME ZONE 'America/Bogota')
                         AT TIME ZONE 'America/Bogota') AT TIME ZONE 'UTC'
GROUP BY c."robotUser", r.host
ORDER BY c."robotUser";
```

**Velocidad y estabilidad de cada máquina (últimas 24 h):**

```sql
SELECT "robotUser", action,
       count(*)                                                          AS acciones,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY "durationMs")        AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")        AS p95_ms,
       count(*) FILTER (WHERE result = 'ERROR')                          AS errores,
       count(*) FILTER (WHERE result = 'UNCERTAIN')                      AS inciertos
FROM "RpaActionLog"
WHERE "createdAt" >= (now() AT TIME ZONE 'UTC') - interval '24 hours'
GROUP BY "robotUser", action
ORDER BY "robotUser", action;
```

**Estado actual de cada robot y su equipo:**

```sql
SELECT r."robotUser", r.host, r.version, r.state, r."lastSeenAt", r.paused, r.enabled,
       s.status AS sesion_abaya, s."consecutiveFails"
FROM "Robot" r LEFT JOIN "RpaSession" s ON s."robotUser" = r."robotUser"
ORDER BY r."robotUser";
```

## 15. Pendientes, riesgos y próximos pasos

### 15.1 Insumos externos (bloquean el paso a producción)

| Pendiente                                                                                         | De quién       |
| ------------------------------------------------------------------------------------------------- | -------------- |
| Ambiente de pruebas de Abaya y un usuario robot por computador                                    | Claro          |
| Respuesta sobre MFA, expiración de sesión y **chats simultáneos por usuario**                     | Claro          |
| Dónde corren los robots (red, VPN, lista de IP)                                                   | Claro          |
| Planes y precios oficiales, texto legal de autorización, formato de la nota                       | Claro          |
| Documento escrito de la autorización para la Trazabilidad (referencia en D-002)                   | Claro          |
| Días de retención del contenido de las conversaciones (y si ventas y consentimientos tienen otro) | Claro          |
| API keys de al menos dos proveedores de LLM (o modelo en la nube de Claro); sin ella no se evalúa | Equipo / Claro |
| Servidor de despliegue con Docker                                                                 | Equipo         |

### 15.2 Trabajo técnico pendiente (no depende de terceros)

1. `docker-compose.server.yml` para el servidor (sin `rpa`, Redis con contraseña, PostgreSQL con
   TLS, puertos restringidos).
2. Certificado de firma de código de la empresa para el instalador (solo evita el aviso de
   Windows en la primera instalación; las actualizaciones ya van firmadas con la clave propia).
3. Descubrimiento real de Abaya (F1) apenas haya acceso: selectores, fixtures sanitizados y
   confirmación de la lectura simultánea de chats.
4. Evaluación con LLM real, prueba de resistencia de 8 h y piloto con 1 robot.
5. Definir cómo se publica el panel `interfazRPA` en el servidor (build estático detrás del mismo
   origen que `/admin`) y retirar `apps/panel`.
6. Llevar los Brains al esquema de D-005 si se quiere publicarlos sin esperar la evaluación.
7. pgvector en el PostgreSQL del servidor para la búsqueda (RAG) de los Brains (D-001).
8. Guardar el teléfono del cliente cifrado, el origen de cada respuesta y el recorrido de etapas
   para completar la Trazabilidad.

### 15.3 Riesgos principales

| Riesgo                                              | Mitigación                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Cambios en la interfaz de Abaya                     | Selectores centralizados y semánticos, alerta de selector roto, prueba de humo cada 15 min.                                               |
| Respuesta en el chat equivocado                     | Una acción a la vez por robot y verificación de identidad del chat antes de escribir.                                                     |
| El LLM inventa precios o condiciones                | El modelo nunca escribe datos: catálogo + plantillas + validadores en cada respuesta + suite de evaluación.                               |
| Se publica un guion que falla la evaluación (D-005) | Riesgo aceptado: los validadores frenan cada respuesta inválida (rehace o frase segura) y el reporte queda en el historial para corregir. |
| Exposición de conversaciones reales (Trazabilidad)  | Solo ADMIN, contenido cifrado en la base, nunca en logs, cada apertura y exportación auditada, retención configurable.                    |
| Caída de un computador                              | Los demás robots siguen; alerta de heartbeat perdido; al volver, reconciliación del estado.                                               |
| Caída del servidor central                          | Ningún robot actúa (falla cerrado); respaldos diarios de la base.                                                                         |
| Mismo usuario de Abaya en dos equipos               | Bloqueado por el sistema: el segundo equipo no inicia sesión y se alerta.                                                                 |
| Robo o pérdida de un equipo robot                   | El equipo no tiene la base, Redis ni la clave; su token está protegido con DPAPI. Deshabilitar en el panel lo revoca al instante.         |
| Copia del archivo del robot                         | Token atado al usuario de Windows (DPAPI) y rotativo: un reúso revoca el robot y alerta `ROBOT_TOKEN_REUSE`.                              |
