# Diagramas del proyecto

Diagramas para documentación. Los `.html` se abren con doble clic (sin servidor ni internet); el botón
**Exportar** los guarda como PNG, SVG o PDF. Las etiquetas **SRC** enlazan al código en GitHub en el
commit con que se hicieron.

| Archivo | Qué muestra | Hecho con | Commit |
| --- | --- | --- | --- |
| `arquitectura.html` | Arquitectura del software: PC del robot, pasarela, API, motor, Redis, PostgreSQL, panel y servicios externos | Archify (architecture) | `1b29b83` |
| `base-de-datos-conversaciones.html` | Tablas 1/3: conversaciones, ventas y robots | Archify (erd) | `1b29b83` |
| `base-de-datos-agente-panel.html` | Tablas 2/3: agente, modelo de lenguaje y panel | Archify (erd) | `1b29b83` |
| `base-de-datos-conocimiento.html` | Tablas 3/3: conocimiento (Brains) | Archify (erd) | `1b29b83` |
| `flujo-mensaje.html` | Del mensaje del cliente a la respuesta (técnico, por procesos) | Archify (workflow) | `9c9aa55` |
| `proceso-venta.md` | Proceso de venta (diagrama de flujo clásico, blanco y negro) | Mermaid | — |
| `arquitectura-mermaid.md` | Arquitectura simple con tabla de componentes | Mermaid | — |

Los Mermaid se ven en GitHub o en https://mermaid.live (pegar el bloque `mermaid`).

## Actualizarlos

Hacerlo cuando cambien la arquitectura o `packages/db/prisma/schema.prisma`, y siempre después del
commit (Archify verifica las referencias contra el commit, no contra cambios sin guardar).

Requiere la skill Archify de Claude Code (`~/.claude/skills/archify`, versión 3.2.0 o superior).
En `fuentes/` está la especificación (`.json`) de cada diagrama.

- **Base de datos:** desde la raíz del repositorio
  ```bash
  node docs/diagramas/fuentes/generar-base-de-datos.cjs
  # por cada carpeta .archify/erd-<tema>-<fecha> que imprime:
  node ~/.claude/skills/archify/bin/archify.mjs finalize erd <carpeta>/candidate.json <carpeta>/<tema>.html --repo-root . --quality standard --json
  ```
  Lee el esquema de Prisma (todas las columnas, llaves y relaciones declaradas). Si se agrega una
  tabla, hay que ubicarla en un dominio del script (si no, falla con «sin diagrama»).
- **Arquitectura y flujo:** pedirle a Claude Code que los regenere con Archify a partir de
  `fuentes/arquitectura.json` o `fuentes/flujo-mensaje.json`, revisando las referencias al código.

Al terminar, copiar el `.html` resultante aquí con el mismo nombre y su `candidate.json` a `fuentes/`.
