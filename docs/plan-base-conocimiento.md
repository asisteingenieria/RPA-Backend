# Plan: integrar la entrega «RV Base de Conocimiento y Flujo Conversacional»

> Fecha: 08/11/2026. Fuente: `Descargas\RV Entrega de Base de Conocimiento y Flujo Conversacional`
> (blueprint «RPA Bictoria · Ecommerce Móvil (WhatsApp)», 6 páginas, y 11 KB en Markdown).
> Objetivo: (1) cargar estas fuentes en los Brains y el guion, y (2) dejar el RPA listo para que
> **cualquier cambio de guion o de flujo se haga desde el panel**, sin tocar código (D-015 llevado al
> flujo completo).
>
> Este documento es un plan: no cambia código. Según la forma de trabajo, las decisiones nuevas
> (D-033 y siguientes) se escriben primero en `docs/planRPA.md` y `docs/DECISIONS.md`.

## 1. Qué llegó

### Blueprint (drawio y HTML)

| Página                    | Contenido                                                                                                                                                                                                                                                              | Uso para nosotros                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 01 Flujo conversacional   | Nodos: inicio, saludo, identificación, bienvenida, perfilamiento (FC-01), segmentación (FC-02), sub-agentes Migración, Portabilidad, Línea nueva, Servicio y ventas, T&T/Hogar, guardrail, módulo «otro plan» (FC-50) y procesos globales de inactividad (FC-90/91/92) | Es el flujo que tiene que ejecutar el motor                              |
| 02 Contratos de nodo      | Por nodo: tipo (PLANT, DEC, KB, PROMPT, TERM, PROC), objetivo, entrada, qué lee y qué escribe, salidas, KB y errores                                                                                                                                                   | Es casi un esquema de datos: base para el «flujo como datos» (sección 4) |
| 03 Estado global          | 24 variables (`segmento`, `sub_agente_activo`, `rebates_usados`, `ultimo_nodo_valido`…) y los valores de `resultado_conversacion`                                                                                                                                      | Equivale a nuestro `Profile` y `Conversation`                            |
| 04 Captura y taxonomías   | Campos con validación: nombre completo, cédula, **línea a activar (único indispensable)** y ciudad; listas cerradas de objeción, servicio, segmento y operador                                                                                                         | Cambia `saleData`                                                        |
| 05 Tipificaciones         | Árbol de etiquetas de cierre del canal Ecommerce Móvil                                                                                                                                                                                                                 | Cambia D-025                                                             |
| 06 Catálogo de plantillas | PLT-001 a PLT-022 (texto literal) y PRM-01 a PRM-05 (texto que genera la IA)                                                                                                                                                                                           | Plantillas y guion del panel                                             |

### KB (Markdown)

| Archivo                                      | Qué es                                                                                                                                                | Tipo de fuente en el Brain                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Oferta Migracion.md                          | 15 planes con precio, TMCODE, gigas, apps, beneficios, campaña (25 % CFM meses 1 y 2)                                                                 | **Catálogo** del proceso Migración                                                   |
| Oferta pospago Portabilidad.md               | 16 planes, campaña 20 % CFM meses 1 a 5                                                                                                               | **Catálogo** de Portabilidad                                                         |
| Oferta pospago Linea Nueva.md                | 1 plan (Conectados 26.1 V 53.9)                                                                                                                       | **Catálogo** de Línea nueva                                                          |
| Plan Exlusivo Mighracion.md                  | 1 plan exclusivo de Migración (41.900)                                                                                                                | **Catálogo** de Migración                                                            |
| Objeciones.md                                | Argumentario por objeción (precio, competencia, necesidad, confianza, «lo voy a pensar», cobertura, permanencia, tiempo) y guion de venta no efectiva | Documento, contexto completo, **solo en objeciones**                                 |
| FAQ Comercial.md                             | 30 preguntas (Claro Video, eSIM, roaming, Lookout…)                                                                                                   | Documento, contexto completo o búsqueda                                              |
| Servicio al Cliente Claro.md                 | Teléfonos, WhatsApp 311 200 0000, app Mi Claro                                                                                                        | Documento; los textos que se envían siguen en la plantilla SOPORTE                   |
| Legal Regulatorio.md (71 KB)                 | Política de tratamiento de datos de Claro                                                                                                             | Documento con **búsqueda**, solo para preguntas legales                              |
| Lineamientos Tratamiento Datos Personales.md | **Guion Habeas Data** y reglas (antes del ATDP solo se puede pedir nombre y ciudad)                                                                   | Texto → plantilla del sistema `AUTORIZACION`; reglas → ya las aplica el código       |
| KB Apertura Perfilamiento.md                 | Cómo clasificar y enrutar sin vender                                                                                                                  | Sección del **guion** para la etapa de apertura (son instrucciones, no conocimiento) |
| Plantillas Presentacion Oferta.md            | Cómo presentar la oferta                                                                                                                              | Sección del **guion** para la oferta                                                 |

## 2. Problemas de la entrega que hay que resolver antes de cargarla

| #   | Problema                                                                                                                                           | Riesgo si se carga así                                                                                        | Quién resuelve                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| P1  | **Vigencia vencida:** todas las KB dicen «agosto 2026» (hoy es 08/11/2026); varias dicen «del 1 de agosto al 1 de agosto».                         | Ofrecer precios y descuentos que ya no están vigentes                                                         | Claro / RV: catálogo de noviembre                                           |
| P2  | **Hay KB escritas para voz:** Plantillas de oferta y Objeciones hablan de «llamada», «decir los números en palabras», «sin emojis».                | El agente escribiría «cincuenta y dos mil novecientos pesos» por WhatsApp                                     | Nosotros: adaptar a texto (y confirmarlo con RV)                            |
| P3  | **El blueprint no tiene la autorización de datos (ATDP):** de «Acepta» pasa directo a «Captura de datos» (PLT-013 pide la cédula).                 | Va contra los Lineamientos, la FAQ 27-28, la regla de la sección 7 y el requerimiento 4 de seguridad de Claro | **No negociable:** el motor siempre pone ATDP antes de PLT-013. Avisar a RV |
| P4  | **Intentos de objeción:** el blueprint dice 3 rebates y la KB de Objeciones dice 5.                                                                | Comportamiento distinto al esperado                                                                           | Claro / RV (queda configurable en el panel)                                 |
| P5  | PLT-011 dice «es de las más solicitadas… alta demanda», pero la KB de Plantillas prohíbe afirmar «la más vendida» sin dato.                        | Afirmación comercial sin respaldo                                                                             | Claro / RV                                                                  |
| P6  | El blueprint pide KB-04 «Oferta nacional» y KB-05/06/07 de objeciones por ruta: llegó un solo archivo de Objeciones y no llegó la oferta nacional. | El módulo «otro plan» (FC-50) no tiene de dónde buscar                                                        | RV                                                                          |
| P7  | Planes repetidos con sufijos `_MM`, `_TS`, `_TM` (mismo precio, TMCODE distinto).                                                                  | No sabemos cuál ofrecer ni qué los diferencia                                                                 | Claro / RV                                                                  |
| P8  | En el plan de 99.900, «precio con impuestos 66.700» y «precio final 99.900» no cuadran.                                                            | El validador podría aceptar una cifra equivocada                                                              | Claro / RV (usar siempre «Precio a comunicar»)                              |
| P9  | La segunda lectura de autorización que pide seguridad de Claro no está en la entrega; solo un texto («¿Acepta Ud.? Si o no»).                      | Requerimiento 4 incompleto                                                                                    | Claro (Cumplimiento)                                                        |
| P10 | PLT-005 (retoma) tiene 1 de 6 variantes («variantes 2 a 6 pendientes de copy»).                                                                    | Se repetiría el mismo texto                                                                                   | RV                                                                          |
| P11 | El agente se llama «Bictoria» (con B).                                                                                                             | Si es un error, sale en cada bienvenida                                                                       | Confirmar con RV (se cambia en el panel)                                    |
| P12 | Reagendamiento (franjas lunes a viernes 08–18) está en las KB pero no tiene nodo en el blueprint.                                                  | Funcionalidad sin definir                                                                                     | RV                                                                          |

## 3. Qué cambia frente a lo que hace hoy el robot

| Tema           | Hoy (D-0xx)                                                     | Blueprint                                                                                  | ¿Se puede hoy desde el panel?                                   |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Apertura       | Saludo + menú de letras A/B/C/D (D-014, D-017)                  | Saludo → pide el nombre → bienvenida → «¿cómo podemos ayudarte?»; el cliente escribe libre | **No**: el menú de letras es fijo en el flujo                   |
| Enrutamiento   | Letra del menú + operador (D-021)                               | Router en cada turno (FC-00) y segmentación (FC-02), sin reiniciar                         | Parcial                                                         |
| Sub-agentes    | Portabilidad, Migración, Línea nueva; C/D → «¿en qué te ayudo?» | + **Servicio y ventas** (un solo ofrecimiento pospago antes de SAC) y **T&T/Hogar**        | **No**                                                          |
| Oferta         | Imágenes (D-014) o `{{OFERTA:CODIGO}}`                          | Texto «PROMOCIÓN FLASH» + detalle de 1 a 4 planes desde el KB, recomendación y cierre      | Sí (guion y plantillas), si el catálogo carga desde el Markdown |
| Objeciones     | Sin tope; «no me interesa» en objeciones → cierre               | **3 rebates** con ángulos distintos y luego no venta con su etiqueta                       | **No** (falta contador configurable)                            |
| Otro plan      | El modelo ofrece otro del catálogo del proceso                  | Módulo FC-50: busca en el KB del proceso y en la oferta nacional                           | Parcial                                                         |
| Guardrail      | Fuera de alcance → SOPORTE/ESCALAR por etapa; insultos (D-018)  | 5 intentos de manipulación o fuera de contexto → cierre; vuelve a `ultimo_nodo_valido`     | **No** (falta contador)                                         |
| Autorización   | ATDP con «SÍ AUTORIZO» antes de los datos                       | No aparece (P3)                                                                            | Se mantiene la nuestra                                          |
| Datos          | Documento, nombre y correo                                      | Nombre completo, cédula, **línea a activar (crítica)** y ciudad, con validaciones          | **No**: faltan CIUDAD y la regla de «crítico»                   |
| Inactividad    | Cada 2 min, 3 intentos, luego cierre (D-013)                    | Cada 3 min, 6 variantes rotativas, **tope de 30 min** y etiqueta según si hubo rebate      | Parcial (minutos e intentos sí; tope y regla de etiqueta no)    |
| Tipificación   | El modelo elige de una lista cerrada (D-025)                    | Árbol nuevo; abandono con rebate = no venta de la ruta                                     | **No** (lista fija en código)                                   |
| Transferencias | Al backoffice con «Finalizar»                                   | A la cola «Backoffice IA móvil» y, para SAC, a la cola «UMM_Atencion_Organico_Fijo»        | **No**: es una acción nueva en ySocial                          |

Conclusión: el guion, las plantillas y los Brains ya se manejan desde el panel; **el camino de la
conversación no**. Hoy el flujo es un conjunto de perillas sobre una máquina de estados fija (menú
de letras, tres procesos). El blueprint es otra forma de flujo, y la próxima entrega puede volver a
cambiarla. Para no volver a tocar código en cada cambio, el flujo tiene que pasar a ser **datos**.

## 4. Propuesta: el flujo como datos (D-033)

**Recomendación:** que la versión del agente (`AgentConfigVersion.flow`) guarde un **grafo de
nodos** con los mismos tipos que usa el blueprint, editable en el panel, y que el motor lo ejecute.
Se mantienen las reglas de la sección 7: **el modelo no decide el camino**. Solo clasifica el
mensaje en una de las salidas cerradas de cada nodo, y el código mueve la conversación.

### Tipos de nodo (los del blueprint)

| Tipo             | Qué hace                                                                                                 | Lo configura el panel                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `PLANTILLA`      | Envía una plantilla (texto exacto)                                                                       | Plantilla, siguiente nodo                                              |
| `CONDICION` (FC) | El modelo clasifica el mensaje en una salida de una **lista cerrada**; el código elige el nodo siguiente | Salidas, nodo de cada salida, instrucción para clasificar, repreguntas |
| `GENERADO` (PRM) | El modelo redacta (rebates, otro plan) con el guion y las KB del nodo; pasa por los validadores          | Instrucción, Brains/documentos que puede usar, máximo de intentos      |
| `OFERTA`         | Presenta planes del catálogo del proceso (texto o imágenes)                                              | Proceso, cuántos planes, orden, plantilla                              |
| `CAPTURA`        | Pide y valida datos                                                                                      | Campos, validación, cuál es crítico                                    |
| `AUTORIZACION`   | ATDP (una o dos lecturas)                                                                                | Plantillas; **el panel no deja llegar a CAPTURA sin pasar por aquí**   |
| `TIPIFICACION`   | Pone el resultado y la etiqueta                                                                          | Etiqueta                                                               |
| `TRANSFERIR`     | Pasa a una cola de ySocial                                                                               | Cola (backoffice o SAC), plantilla al cliente                          |
| `CERRAR`         | Cierra el caso                                                                                           | —                                                                      |
| `SUBAGENTE`      | Agrupa nodos (Migración, Portabilidad…) y su catálogo                                                    | Nombre, proceso, Brains                                                |

**Procesos globales configurables:** router en cada turno (FC-00), guardrail con contadores,
inactividad (intervalo, variantes, tope duro, etiqueta según hubo rebate o no), `ultimo_nodo_valido`
para retomar sin repetir el saludo.

### Lo que sigue siendo código (no se puede quitar desde el panel)

- Nunca pedir documento, correo ni línea sin autorización: el panel no deja guardar un flujo con un
  camino a `CAPTURA` que no pase por `AUTORIZACION`, y el motor también lo verifica en cada turno.
- Consentimiento determinista («SÍ», regex en código), cifras validadas contra el catálogo, textos
  legales solo de plantillas, identidad del chat, kill switch, enmascarado.
- Las acciones en ySocial (enviar, transferir a una cola, tipificar, cerrar) las hace el robot. El
  panel solo elige **cuál** y con qué datos (nombre de la cola, etiqueta).

### Por qué no seguir agregando perillas

Se puede (menú opcional, contador de rebates, campo CIUDAD…) y sería más rápido para esta entrega,
pero cada cambio del blueprint volvería a necesitar código. Con el grafo, el código se toca una vez.
Como paso intermedio, la versión actual del flujo se convierte automáticamente en un grafo
equivalente, y las versiones publicadas siguen funcionando igual.

### Edición en el panel (`interfazRPA`)

- Editor del flujo: lista de nodos por sub-agente con sus salidas (y, más adelante, una vista de
  diagrama). Revisión al guardar: nodos sin salida, salidas sin destino, plantillas inexistentes,
  CAPTURA sin AUTORIZACION, ciclos sin salida.
- **Importar el blueprint:** leer el `.drawio` de RV (ids de nodo `aOf`, `FC-10`, `PLT-013`…) y
  armar un borrador del grafo para revisarlo. Así la próxima versión del blueprint entra sin
  transcribirla a mano.
- «Probar agente» y la suite de evaluación sobre el grafo, como hoy. Publicar sigue el mismo camino:
  guardar → probar → evaluar → publicar → restaurar.

## 5. Integración del conocimiento

1. **Catálogo desde Markdown (código, una vez).** Hoy el catálogo sale de Excel/CSV o de imágenes.
   Se agrega un lector para el formato de estas KB (bloques `## Conectados …` con Precios,
   Características, Beneficios, Campaña, Vigencia). El TMCODE es el código del plan, el mismo que
   ya usan las imágenes (`P38327` ↔ TMCODE 38327), y la campaña queda como descuento por proceso
   (D-016). Al cargar se muestra un diff y los errores (P7, P8).
2. **Vigencia (código, una vez).** Cada fuente guarda su vigencia; el panel avisa cuando vence, y
   publicar un Brain con el catálogo vencido pide confirmación expresa (P1).
3. **Documentos por etapa (código, una vez).** Hoy los documentos de un Brain entran en todos los
   turnos. Se agrega «en qué nodos o sub-agentes se usa» cada documento: Objeciones solo en los
   rebates, Legal solo en dudas legales, FAQ en oferta y dudas. Gasta menos tokens y evita que la
   apertura responda con contenido de la oferta (lo que pide la KB de Apertura).
4. **Carga (panel, sin código):**
   - Brain «Planes Noviembre» (cuando llegue la vigencia nueva): las 4 KB de oferta como catálogo,
     una por proceso.
   - Brain «Conocimiento comercial»: FAQ, Objeciones (adaptada a texto) y Servicio al cliente, con
     contexto completo.
   - Brain «Legal»: Legal Regulatorio con búsqueda.
   - Guion: secciones por sub-agente a partir de la KB de Apertura y la de Plantillas (adaptadas a
     WhatsApp: cifras como «$53.900», sin pasar números a palabras).
   - Plantillas: PLT-001 a PLT-022 con sus códigos, más las del sistema (AUTORIZACION con el guion
     Habeas Data de los Lineamientos, DATOS_FALTANTES, TRANSFERENCIA…).

## 6. Fases

| Fase | Trabajo                                                                                                                                                                             | Código           | Panel                       | Depende de                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------- | ---------------------------------- |
| 0    | Resolver P1–P12 con RV y Claro; registrar D-033 (flujo como datos) y D-034 (catálogo Markdown y documentos por etapa)                                                               | —                | —                           | RV, Claro                          |
| 1    | Conocimiento: lector de catálogo Markdown, vigencias y documentos por etapa; pruebas                                                                                                | Sí               | Carga de los Brains         | Fase 0 (P1, P7, P8)                |
| 2    | Motor de grafo: tipos de nodo, procesos globales, conversión del flujo actual a grafo, validaciones de seguridad; suite de evaluación con casos por salida de cada FC del blueprint | Sí               | —                           | —                                  |
| 3    | Panel: editor del flujo, importar drawio, documentos por etapa, vigencias, etiquetas                                                                                                | Sí (interfazRPA) | —                           | Fase 2                             |
| 4    | ySocial: transferir a una cola por nombre (backoffice y SAC) y etiquetas desde la configuración (los selectores siguen en `selectors.ts`, el texto viene de la configuración)       | Sí (robot)       | Nombres de cola y etiquetas | Grabación o prueba en ySocial real |
| 5    | Armar el flujo «Bictoria» **desde el panel** (importar el blueprint, ajustar, cargar plantillas y Brains), probar, evaluar y publicar                                               | **No**           | Sí                          | Fases 1–4                          |
| 6    | Piloto en horario reducido; ajustes solo desde el panel                                                                                                                             | No               | Sí                          | Fase 5                             |

Criterio de éxito: después de la fase 5, un cambio del blueprint (nuevo nodo, otra plantilla, otro
tope de rebates, otro orden de preguntas) se hace en el panel y pasa por «Probar agente» y la suite,
sin release del servidor ni del robot. El código solo se toca para la sección 7 o para una acción
nueva en ySocial (D-015).

**Disponibilidad:** cada fase se despliega fuera del horario del robot (07:00–22:00); la versión
publicada del agente sigue funcionando con el motor nuevo (conversión automática) y se puede
restaurar la anterior desde el panel.

## 7. Preguntas para RV y Claro

1. Catálogo vigente de noviembre (P1) y qué significan `_MM`, `_TS`, `_TM` (P7).
2. ¿Ofrecemos en texto como dice el blueprint o seguimos con las imágenes de los planes (D-014)?
3. Tope de rebates: ¿3 (blueprint) o 5 (KB de Objeciones)? (P4)
4. ¿Se puede decir «de las más solicitadas» (PLT-011)? (P5)
5. KB-04 Oferta nacional y objeciones por ruta (P6); variantes 2 a 6 de PLT-005 (P10).
6. Confirmar que la autorización de datos va antes de PLT-013 (P3) y el texto de la segunda lectura (P9).
7. ¿El correo deja de pedirse? El blueprint pide línea a activar y ciudad, no correo.
8. Nombres exactos de las colas en ySocial («Backoffice IA móvil», «UMM_Atencion_Organico_Fijo») y
   permiso del usuario robot para transferir a ellas.
9. Nombre del agente: ¿«Bictoria»? (P11). Reagendamiento: ¿entra en esta versión? (P12)

## 8. Avance

### 09/11/2026 — Reglas y flujo aplicados en local, ofertas sin cambios (D-033)

- **Ofertas:** se dejan las imágenes publicadas (Brain «Planes Agosto»). Comparación con las KB de
  oferta: mismos precios, gigas y descuentos en los 13 planes comunes; diferencias de códigos y de
  qué se ofrece en cada proceso (99.900 de Portabilidad con código de Migración, Netflix del 37230,
  GB para compartir del 75.900 y 65.900, línea nueva, plan 38178 y circulares de video que no
  están en la KB). Pendiente de Claro.
- **Código (perillas del flujo, D-033):** inicio sin menú, tope de rebates por objeción y ciudad
  en los datos; editor del flujo en `interfazRPA`.
- **Contenido:** por pedido del usuario, la v25 conserva las plantillas, la apertura con menú, el
  flujo, el ofrecimiento y la reactivación de la v24 (perillas nuevas apagadas); solo agrega al
  guion reglas de las KB Objeciones, Plantillas y Lineamientos que no cambian el camino. Brain
  «Conocimiento Claro» (FAQ, Servicio al Cliente, Lineamientos y Legal con búsqueda) publicado
  (99/100, 0 inventados) y conectado en local; v25 en borrador.
- **Pendiente:** probar en «Probar agente», correr la evaluación con el modelo real y publicar en
  local; después, producción fuera de horario (runbook §12.3). Siguen abiertas las preguntas de la
  sección 7 y las fases 2–4 (flujo como grafo, editor, colas de ySocial).
