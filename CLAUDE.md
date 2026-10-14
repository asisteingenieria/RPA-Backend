# CLAUDE.md — Agente RPA de ventas en Abaya

Robot que opera la aplicación web **Abaya** como un asesor humano: inicia sesión, atiende los chats
asignados, conduce la venta con un **motor de conversación propio** (máquina de estados + catálogo en
base de datos + LLM por API directa que solo redacta) y transfiere la venta al backoffice con una nota
interna. El plan completo y fuente de verdad es `docs/planRPA.md`: **leerlo al iniciar cada fase**.

## Stack

TypeScript estricto (ESM, NodeNext) · pnpm workspaces + Turborepo · NestJS · Playwright (Chromium,
versión fijada) · PostgreSQL + Prisma 7 (adapter `pg`) · Redis + BullMQ · zod · pino · Vitest.

## Procesos

- `apps/rpa` — navegador, sesión, lectura de mensajes, acciones en Abaya (`/health` en `RPA_PORT`).
- `apps/worker` — motor de conversación, ventas, outbox, scheduler.
- `apps/api` — salud, panel, kill switch, auditoría (`/health` en `API_PORT`).

## Comandos

```bash
pnpm install            # dependencias
pnpm db:generate        # cliente Prisma (packages/db/src/generated)
pnpm db:migrate         # migraciones (requiere DATABASE_URL en .env)
pnpm build | lint | typecheck | test
pnpm dev                # los tres procesos en modo watch
docker compose up       # Postgres, Redis y los tres procesos
```

- Las apps cargan `.env` de la raíz con `node --env-file-if-exists`.
- Imports relativos con extensión `.js` (ESM). Nest usa decoradores con `emitDecoratorMetadata`: compilar
  con `tsc`, no con herramientas basadas en esbuild para ejecutar las apps.

## Estructura (sección 4)

```
abaya-rpa/
  apps/
    rpa/
      src/
        abaya/
          selectors.ts              # ÚNICO lugar con selectores
          pages/                    # LoginPage, ChatListPage, ChatPage,
                                    # NotePage, TransferPage
          network/                  # parsers de XHR/WebSocket (zod)
          dom/                      # MutationObserver de respaldo
        session/                    # SessionManager, storageState cifrado
        actor/                      # BrowserActor y acciones
        inbound/                    # InboundWatcher, huella de mensaje
        safety/                     # KillSwitch, ChatIdentityGuard
        observability/              # trazas solo en error
      Dockerfile
    worker/
      src/
        conversation/               # agrupador de ráfagas, turnos
        engine/
          state-machine.ts          # estados y transiciones del flujo de venta
          stages/                   # instrucciones y esquema por estado
          prompts/                  # prompts versionados por estado
          templates/                # textos fijos (legal, precios, despedidas)
          validators/               # anti-alucinación
        llm/
          llm.port.ts
          adapters/                 # anthropic, openai, gemini
        catalog/                    # planes desde base de datos
        sales/                      # venta, consentimiento, resumen
        scheduler/                  # inactividad, humo, limpieza
        outbox/
    api/
      src/
        health/
        admin/                      # panel, kill switch, auditoría
    panel/                          # React + Vite (F7)
  packages/
    domain/                         # entidades, puertos, eventos
    db/                             # schema Prisma y cliente
    config/                         # esquemas zod de configuración
    crypto/                         # cifrado de campos, cadena de hashes
    logger/                         # pino con redacción
  evals/
    conversations/                  # casos guionados (YAML) con resultado esperado
    run-evals.ts                    # corre la suite contra uno o varios proveedores
  fixtures/
    abaya/                          # HTML y payloads SANITIZADOS
  docs/
    planRPA.md                      # este documento
    abaya-mapa-pantallas.md         # resultado de F1
    runbook.md                      # resultado de F8
  docker-compose.yml
  CLAUDE.md
  .env.example
```

## Reglas no negociables (sección 7, textuales)

1. **Nunca escribir en un chat sin verificar su identidad.**
2. **Nunca reintentar a ciegas un envío o transferencia incierta.**
3. **Selectores solo en `selectors.ts`**, semánticos (`getByRole`, `getByText`, `getByLabel`, `data-*`). Prohibidas las rutas CSS largas o por posición.
4. **Toda acción de interfaz pasa por el `BrowserActor`.**
5. **KillSwitch revisado antes de cada acción.**
6. **Sin datos personales en logs**; contenido de mensajes y resúmenes cifrados en base de datos.
7. **Sin credenciales** en código, `.env` versionado, fixtures, trazas ni conversaciones con Claude Code.
8. **Fixtures siempre sanitizados.**
9. **Toda acción queda en `RpaActionLog`** con cadena de hashes.
10. **Toda salida del LLM se valida** (sección 6.3.5) antes de enviar o actuar.
11. **El LLM nunca inventa precios, planes ni descuentos, ni escribe textos legales**: puede copiar cifras y beneficios del catálogo del proceso del cliente y el validador verifica cada una (D-007); los textos legales y las plantillas los pone el código.
12. **El flujo lo decide la máquina de estados**, no el modelo.
13. **Ningún cambio de prompt o de modelo sale sin pasar la suite de evaluación.**

## Forma de trabajo (sección 16)

- Una fase por sesión; modo plan primero; commit al final de cada fase con CI en verde.
- Nunca pegar credenciales, HTML sin sanitizar ni conversaciones reales.
- Las decisiones se cambian primero en `docs/planRPA.md` y después en el código.
- Si una propuesta se salta una regla de la sección 7, la respuesta es no.

## Estado

- [x] F0 Fundaciones
- [~] F1 Descubrimiento de Abaya (provisional contra el Abaya simulado; falta el descubrimiento real)
- [x] F2 Sesión (probada contra el simulador; falta E2E @abaya real)
- [x] F3 Lectura de mensajes (probada contra el simulador y PostgreSQL)
- [x] F4 Envío de mensajes (probada contra el simulador)
- [x] F5 Motor de conversación (catálogo y textos SINTÉTICOS; falta correr evals con proveedores reales)
- [x] F6 Venta y transferencia (probada contra el simulador; formato de nota pendiente de Claro)
- [x] F7 Robustez, operación y panel (falta la prueba de resistencia de 8 h en ambiente real)
- [~] F8 Seguridad (revisión hecha, ver docs/security-review.md) y runbook; falta despliegue y piloto con Claro
- [x] v1.9 Brains: catálogo (K1), panel (K2, en interfazRPA), contexto completo (K3), búsqueda híbrida (K4) y páginas web (K5); falta correr la suite con el LLM real
- [x] v1.10 Abaya = ySocial (D-012), plantillas (D-013) y oferta con imágenes (D-014): Brain «Planes Agosto» v8 publicado y conectado (79/79, 0 inventados; descuentos por imagen, D-016), agente v21 publicado (D-015: conversación configurable en el panel; D-018: insultos y amenazas; imágenes por proceso); el robot pega la imagen en Abaya (probado en el simulador). Falta la prueba en vivo y activar `SEND_PLAN_IMAGES`

## Abaya simulado

Mientras no haya acceso al ambiente de pruebas, `apps/rpa/test/mock-abaya/` simula Abaya
(markup y rutas de ySocial: login, sesión, mensajes, «pegar» imágenes con subida al blob,
finalizar con etiquetas). Las pruebas `*.pw.ts` lo usan. Cuando existan fixtures reales, el simulador se ajusta para imitarlos.
Pruebas contra Abaya real: etiqueta `@abaya`, solo con `ABAYA_E2E=1`. Diagnóstico por pasos
contra Abaya real (D-020): `probar-abaya <url|login|estado|disponible|bandeja> [--ver]`
(`probar.cmd` en el equipo robot; runbook 8.e).

## Motor de conversación (F5)

- `apps/worker/src/engine/`: máquina de estados, plantillas, validadores, prompts versionados.
- Menú y autorización son **deterministas**: solo un "SÍ AUTORIZO" explícito (regex en código) es
  consentimiento; el modelo nunca puede darlo por hecho.
- Catálogo y textos legales son **sintéticos** (`plans.synthetic.csv`, `templates.ts`) hasta
  recibir los oficiales de Claro. Cargar catálogo (Excel o CSV): `pnpm --filter @abaya/worker seed -- <archivo>`.
- Brains (v1.9, `docs/DECISIONS.md` D-001): el catálogo vive en un Brain (`packages/knowledge`);
  el motor usa la versión PUBLICADA (`PublishedBrainCatalog`), la consulta por proceso la hace el
  código, publicar un catálogo pasa por la suite (cola `abaya.evals`, `kind: 'brain'`) y cada turno
  deja `KnowledgeUsage`. API en `/admin/knowledge/*`; ingesta por la cola `abaya.knowledge-ingest`.
  Documentos: contexto completo y búsqueda híbrida (`PgHybridSearch`, embeddings por
  `EMBEDDINGS_PROVIDER`), páginas web con `SafeWebFetcher` (SSRF). Publicar exige ADMIN con
  `knowledgePublisher`.
- **D-015: la conversación se configura en el panel, no en el código.** Lo que el agente dice, ofrece y
  cómo responde va en el guion, las plantillas y los Brains. El camino lo define el **flujo** de la versión
  (`AgentConfigVersion.flow`, `packages/domain/src/agent-flow.ts`): letras del menú y a qué llevan, datos
  por proceso y su primera plantilla, fuera de alcance por etapa (soporte o asesor) y orden de imágenes.
  Los textos que el código envía son **plantillas del sistema** (`SYSTEM_TEMPLATE_ROLES`: SOPORTE,
  ESCALAR, TRANSFERENCIA, RESPUESTA_SEGURA, ESPERA…; sin cifras; si faltan, las de la campaña). No poner
  instrucciones de negocio en `buildRequest`: solo datos del turno y mecánica de marcadores. El código
  se toca solo para la seguridad (sección 7) o una acción nueva en Abaya.
- Configuración del agente en el panel (v1.8, sección 6.3.8): guion en Markdown + ajustes en
  `AgentConfigVersion`; reglas del sistema, revisión y armado del prompt en
  `packages/domain/src/agent-config.ts`. Publicar corre la suite en el worker (cola
  `abaya.evals`, `apps/worker/src/evals/agent-evaluation.ts`); "Probar agente" usa la cola
  `abaya.agent-test`. Núcleo de la suite: `apps/worker/src/evals/suite.ts`.
- Suite de evaluación: `pnpm evals` (línea base sin red) o
  `pnpm evals -- --provider anthropic,openai,gemini` (requiere API keys). Meta: 0 datos inventados, ≥ 95 %.
- Oferta con imágenes (D-014, plan 6.3.10): un Brain sin Excel toma los planes de las imágenes
  (`recordsFromImages`, códigos con la inicial del proceso: `P38327`). El modelo ofrece con
  `{{IMAGENES}}` (primero la imagen del plan más caro del proceso del cliente; las compartidas
  después), la circular de video con `{{IMAGENES_VIDEO}}` (nunca en la primera oferta; solo la de la
  plataforma nombrada, una vez cada una) y explica un plan con `{{DETALLE:CODIGO}}`
  (`planDescription`, formato de la campaña). El pie de foto va en singular o plural según los
  planes de la imagen. Sin envío de imágenes (suite, o `SEND_PLAN_IMAGES=false`) se ofrece con
  `{{OFERTA:CODIGO}}`. El robot pega la imagen en ySocial (`Message.imageId`,
  `BrowserActor.sendImage`, pasarela `GET /robot-api/v1/outbound/image`).
- Entre ambientes (D-019): exportar/importar la versión del agente (`abaya-agente`) y los Brains
  (`abaya-brain`, imágenes sin releer); el guion no se guarda si nombra una plantilla inexistente.
  Pasos en `docs/runbook.md` 8.c.
- Datos tras el «SÍ» (13/10/2026): la venta pasa al backoffice cuando están los datos del flujo
  (`saleData`: documento, nombre completo y correo); se reconocen en código (`sale-data.ts`) y lo que
  falta se pide con la plantilla `DATOS_FALTANTES` solo cuando el cliente deja de escribir
  (`saleDataWaitSeconds`, 45 s; mientras manda datos el robot calla); 3 mensajes sin datos nuevos →
  transfiere igual.
- Insultos y amenazas (D-018): no son fuera de alcance; el modelo pone un límite y retoma el paso
  (regla 9 del sistema). Amenazas de violencia: alerta `CUSTOMER_THREAT` a supervisores (determinista).
- Apertura (D-017): al asignarse un caso nuevo el robot envía el saludo con el menú sin esperar
  mensaje (turno `opening`); su primer mensaje es siempre ese saludo, como la asesora.
- Menú (D-014): A → Portabilidad (operador → uso → red), B → Migración (uso → red), línea nueva solo
  si el cliente la pide (opción interna `E`); C/D → «¿en qué te puedo ayudar?» (`needAsked`) y, si
  no es compra, plantilla de chat exclusivo de ventas.
- Reactivación (D-013): cada 2 min, 3 intentos con plantillas distintas (no se repiten en la
  conversación); agotados → cierre «Cliente abandona conversación» (`AgentConfigVersion.reactivation`).
- «Probar agente»: la prueba guardada queda en la versión con la que se conversó; el historial
  lista todas en «Pruebas guardadas» (`GET /admin/agent/tests/recent`).
- Gemini (D-006): `LLM_PROVIDER=gemini` y `EMBEDDINGS_PROVIDER=gemini` con `GEMINI_API_KEY`;
  adaptador por API REST (sin SDK) en `apps/worker/src/llm/adapters/gemini.adapter.ts`.

## Pruebas de integración con PostgreSQL

Los archivos `*.int.test.ts` levantan un PostgreSQL temporal con `@abaya/db/testing`
(`embedded-postgres`, puerto libre, carpeta temporal, migraciones aplicadas): no tocan ninguna base
real. Las cadenas de hashes (`ConsentEvidence`, `RpaActionLog`) tienen `prevHash` único (no pueden
bifurcarse) y la punta se busca por `seq`; las transacciones Serializable se reintentan con
`withSerializableRetry`.

## Operación (F7)

- Panel: `http://<api>/panel` (build de `apps/panel`) con usuarios y contraseña (v1.3): roles
  `ADMIN`/`OPERADOR`, sesión en cookie `httpOnly` (`AdminSession`), cabecera
  `x-requested-with: abaya-panel` en peticiones que cambian algo. Primer ADMIN:
  `pnpm --filter @abaya/api create-admin -- <usuario>` (contraseña temporal, cambio obligatorio).
- Kill switch en caliente: bandera `abaya:killswitch` en Redis (panel → rpa), falla cerrado; pausa
  por robot con `abaya:pause:<robot>` (revisadas juntas antes de cada acción).
- Robots padre/hijo (v1.4) e "hijo delgado" (v1.6, secciones 2.6 y 2.8 del plan): el robot
  instalado (`robot.json` v2, protegido con DPAPI) habla SOLO con la pasarela del servidor
  (`/robot-api/v1`: `enroll`, `token`, `config`, `rpc`, `traces`, WebSocket `ws`); nunca recibe
  base de datos, Redis ni la clave. Protocolo y persistencia compartida en `@abaya/robot-store`;
  pasarela en `apps/api/src/robots/gateway/`; cliente y backends en `apps/rpa/src/child/` y
  `apps/rpa/src/backend/` (directo = desarrollo/demo, hijo = producción). Cada operación verifica
  que los datos sean del robot del token. Instalador Windows: `pnpm robot:package`. Códigos de
  salida del rpa: 3 = no reintentar, 4 = activar versión nueva.
- Actualizaciones (v1.7, sección 2.9): paquetes firmados con Ed25519 (`pnpm robot:keys` crea
  `.secrets/release-signing.key` y `apps/rpa/release-key.pub`; `pnpm robot:package` firma).
  Robot: `apps/rpa/src/update/updater.ts`; lanzador `apps/rpa/installer/iniciar.ps1` (versiones
  lado a lado y reversión automática); servidor: `ReleaseService` y botones en el panel.
- Colas de acciones por robot: `abaya.outbound|transfer|close.<robotUser>`.
- Trazas solo en error, cifradas, en `TRACE_DIR` (7 días); `decryptTrace` para verlas.
- Alertas: logs + `ALERT_WEBHOOK_URL` (Slack/Teams), sin datos personales.
- Capacidad (v1.5, sección 2.7 del plan): 3 chats por robot (`MAX_CHATS_PER_ROBOT`), fila del
  `BrowserActor` con prioridad (`PRIORITY` en `serial-executor.ts`: enviar > abrir > transferir >
  leer > cerrar > reciclar), tiempo de respuesta `Message.respondsToAt → sentAt` (reloj del robot;
  consultas en `@abaya/db` `metrics.ts`), alertas `ROBOT_OVERLOADED` y `RESPONSE_SLOW`.
  Prueba de carga: `pnpm build && pnpm loadtest -- --robots N --chats 3 --minutos M`
  (base aparte `abaya_rpa_carga`, se borra al terminar).
