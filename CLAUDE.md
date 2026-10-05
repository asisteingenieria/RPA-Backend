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
11. **El LLM nunca escribe precios, planes, descuentos ni textos legales**: los pone el código desde el catálogo y las plantillas.
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
- [ ] F7 Robustez, operación y panel
- [ ] F8 Seguridad, despliegue y piloto

## Abaya simulado

Mientras no haya acceso al ambiente de pruebas, `apps/rpa/test/mock-abaya/` simula Abaya
(markup semántico + servidor HTTP con login, sesión, mensajes, notas y transferencias). Las pruebas
`*.pw.ts` lo usan. Cuando existan fixtures reales, el simulador se ajusta para imitarlos.
Pruebas contra Abaya real: etiqueta `@abaya`, solo con `ABAYA_E2E=1`.

## Motor de conversación (F5)

- `apps/worker/src/engine/`: máquina de estados, plantillas, validadores, prompts versionados.
- Menú y autorización son **deterministas**: solo un "SÍ AUTORIZO" explícito (regex en código) es
  consentimiento; el modelo nunca puede darlo por hecho.
- Catálogo y textos legales son **sintéticos** (`plans.synthetic.json`, `templates.ts`) hasta
  recibir los oficiales de Claro. Cargar catálogo: `pnpm --filter @abaya/worker seed -- <archivo>`.
- Suite de evaluación: `pnpm evals` (línea base sin red) o
  `pnpm evals -- --provider anthropic,openai` (requiere API keys). Meta: 0 datos inventados, ≥ 95 %.

## Pruebas de integración con PostgreSQL

Los archivos `*.int.test.ts` levantan un PostgreSQL temporal con `@abaya/db/testing`
(`embedded-postgres`, puerto libre, carpeta temporal, migraciones aplicadas): no tocan ninguna base
real. Las cadenas de hashes (`ConsentEvidence`, `RpaActionLog`) tienen `prevHash` único (no pueden
bifurcarse) y la punta se busca por `seq`; las transacciones Serializable se reintentan con
`withSerializableRetry`.
