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
- [ ] F1 Descubrimiento de Abaya
- [ ] F2 Sesión
- [ ] F3 Lectura de mensajes
- [ ] F4 Envío de mensajes
- [ ] F5 Motor de conversación
- [ ] F6 Venta y transferencia
- [ ] F7 Robustez, operación y panel
- [ ] F8 Seguridad, despliegue y piloto
