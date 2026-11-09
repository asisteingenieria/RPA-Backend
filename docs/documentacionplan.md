# Plan de documentación de seguridad para la POC con Claro

> Fecha: 03/11/2026. Responde a la solicitud de Claro de evidencias para la POC (7 puntos).
> Regla de entrega de Claro: **una carpeta por evidencia, todos los documentos en PDF.**
> Este plan dice qué pide cada punto, qué tenemos hoy en el código, qué falta construir, quién lo
> entrega y con qué herramientas.

## 0. Supuestos y vocabulario

Claro usa sus propios nombres. Así los leemos (confirmar con Claro, ver sección 11):

| Nombre de Claro                 | Qué es en nuestra solución                                                                                                                               | De quién es              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Sofía**                       | Nuestro agente virtual: servidor (`apps/api` + `apps/worker`) con el motor de conversación, el panel, la base de datos y el LLM (Gemini) por API         | Asiste                   |
| **RPA**                         | El robot instalado en el PC (`apps/rpa`): navegador Chromium que opera la consola de ySocial como asesor                                                | Asiste                   |
| **WhatsApp**                    | WhatsApp Business del cliente, conectado a ySocial                                                                                                       | Claro / Meta / Yoizen    |
| **Menú comercial**              | El bot yFlow de ySocial que atiende antes de que el caso llegue al robot (D-017)                                                                         | Claro / Yoizen           |
| **BRE**                         | Motor de reglas / distribución de tráfico de Claro que asigna los casos                                                                                  | Claro                    |
| **Back office**                 | La cola o los asesores de ySocial a los que el robot transfiere la venta con la nota interna                                                            | Claro (en ySocial)       |
| **SMSC**                        | Centro de mensajes SMS de Claro. **No lo usamos**: hay que declararlo «no aplica» en el inventario                                                       | Claro                    |

## 1. Resumen: quién puede cumplir cada cosa

### Por requerimiento (7)

| #   | Requerimiento                         | Responsable                                                | Estado hoy                                                                                     |
| --- | ------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Arquitectura y flujo de datos         | **Nosotros** (con datos de Claro sobre WhatsApp, yFlow y BRE) | 70 %: diagramas en `docs/diagramas/`; falta la tabla de flujo de datos y el HLS con lo de Claro |
| 2   | Pruebas de seguridad                  | **Nosotros + externo recomendado** (pentest independiente) | 50 %: revisión F8 hecha; faltan TLS 1.3, sacar los secretos del `.env` y los informes formales  |
| 3   | Logs de auditoría                     | **Nosotros**                                               | 40 %: hay `RpaActionLog`, `LlmCall`, `AdminAuditLog`; falta el log por interacción con los campos de Claro |
| 4   | Consentimiento en dos lecturas        | **Nosotros + Claro (Cumplimiento)**                        | 50 %: una lectura con evidencia encadenada; falta la segunda lectura y el texto aprobado        |
| 5   | Gestión de incidentes                 | **Nosotros**                                               | 30 %: hay alertas y kill switch; falta el procedimiento escrito                                 |
| 6   | Cuentas de servicio y PAM             | **Nosotros + externo** (PAM o bóveda aprobada) **+ Claro** (fichas y cartas) | 30 %: no hay credenciales en el código; los secretos del servidor están en `.env` en texto claro |
| 7   | Entorno aislado y sin entrenamiento   | **Nosotros + área legal + proveedor del LLM (Google)**     | 20 %: falta todo lo contractual                                                                |

- **3 requerimientos los cumplimos solos:** 1, 3 y 5 (en el 1 Claro nos da la información de sus componentes).
- **4 requerimientos son mixtos:** 2, 4, 6 y 7.

### Por evidencia (17 entregables)

| Quién entrega                         | Cantidad | Evidencias                                                       |
| ------------------------------------- | -------- | ---------------------------------------------------------------- |
| **Nosotros (Asiste, equipo técnico)** | **12**   | E1.1, E1.2, E2.1, E3.1, E3.2, E4.2, E4.3, E5.1, E6.1, E6.3, E7.1, E7.2 |
| **Proveedor externo**                 | **3**    | E2.2 (pentest independiente), E6.2 (PAM o bóveda), E7.4 (términos del proveedor del LLM) |
| **Claro o área legal**                | **2**    | E4.1 (texto aprobado por Cumplimiento), E7.3 (cláusula contractual) |

De las 12 nuestras, **5 necesitan desarrollo antes de poder evidenciarse** (E2.1, E3.1, E3.2, E4.2 y
E4.3). Las demás son documentación sobre lo que ya existe.

## 2. Requerimiento 1 — Arquitectura completa y flujo de datos

**Qué piden.** Un diagrama de alto nivel (HLS, _High Level Solution_) con **todos** los componentes,
desde el WhatsApp del cliente hasta el back office, incluidos los de Claro (menú comercial, BRE). Y,
para **cada paso**, una tabla con: qué dato pasa (nombre, cédula, correo, conversación), entre qué
componentes, con qué cifrado viaja, quién lo guarda y cuánto tiempo. Lo que quieren ver son los
**puntos de exposición**: dónde podría filtrarse un dato del cliente.

**Qué tenemos.** `docs/diagramas/arquitectura.html` (Archify), `flujo-mensaje.html`, los 3 ERD y
`proceso-venta.md`. No incluyen WhatsApp, yFlow ni el BRE, y no hay tabla de cifrado y retención.

**Qué hay que hacer.**

1. Diagrama HLS nuevo (Archify): Cliente → WhatsApp → ySocial/yFlow (menú comercial) → BRE →
   cola del robot en ySocial → **RPA** (PC EQP4B-77, Chromium) ⇄ **pasarela** (`/robot-api/v1`,
   HTTPS/WSS) → API y worker → PostgreSQL / Redis → LLM (Gemini) → de vuelta a ySocial → back office.
   Marcar con color los puntos de exposición.
2. Tabla de flujo de datos (borrador abajo), revisada con el código.
3. Exportar a PDF.

**Borrador de la tabla de flujo de datos** (las celdas «?» se confirman con Claro o con pruebas):

| Paso | Dato                                         | De → a                              | Cifrado en tránsito                    | Quién lo guarda y cómo                                                     | Cuánto tiempo                                   |
| ---- | -------------------------------------------- | ----------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | Conversación, número de línea                | Cliente → WhatsApp → ySocial        | Cifrado de WhatsApp + HTTPS de Meta (?) | Claro/Yoizen en ySocial                                                     | Política de Claro (?)                           |
| 2    | Conversación                                 | ySocial → RPA (pantalla del navegador) | HTTPS (TLS de ySocial: medir)        | No se guarda en el PC (trazas solo en error, cifradas, 7 días)              | 7 días (trazas)                                 |
| 3    | Conversación, número (hash)                  | RPA → pasarela → API                | HTTPS/WSS (**objetivo TLS 1.3**)       | PostgreSQL: `Message.bodyEncrypted` (AES-256-GCM), `customerRefHash`        | `CONVERSATION_RETENTION_DAYS` (**hoy vacío = no se borra**) |
| 4    | Conversación (teléfonos y cédulas enmascarados) | Worker → Gemini                  | HTTPS (TLS de Google)                  | Google, según sus términos (ver R7)                                         | Según el plan contratado (ver R7)               |
| 5    | Nombre, cédula, correo (tras el «SÍ»)        | Cliente → … → worker                | Igual que 1–3                          | `Conversation.profileEncrypted`, `Sale.summaryEncrypted`                    | Igual que 3                                     |
| 6    | Respuesta de consentimiento                  | Worker → PostgreSQL                 | Local                                  | `ConsentEvidence.customerReplyEncrypted` + cadena de hashes                 | Igual que 3 (hash permanente)                   |
| 7    | Resumen de la venta (nota interna)           | Worker → RPA → ySocial (back office) | WSS + HTTPS de ySocial                | Claro/Yoizen en ySocial                                                     | Política de Claro (?)                           |
| 8    | Pantalla del robot (monitor en vivo, D-032)  | RPA → pasarela → panel ADMIN        | WSS + SSE sobre HTTPS                  | Solo la última imagen, en Redis                                             | 10 s                                            |
| 9    | Conversación completa (Trazabilidad)         | API → panel ADMIN                   | HTTPS                                  | Se descifra para mostrarla; queda `CONVERSATION_VIEWED` en Auditoría        | —                                               |

**Evidencias.** `01-arquitectura/E1.1-HLS.pdf`, `01-arquitectura/E1.2-flujo-de-datos.pdf`.

## 3. Requerimiento 2 — Pruebas de seguridad del RPA, de Sofía y de sus integraciones

**Qué piden.** Pruebas hechas **antes** de iniciar la POC, con informe, sobre:

- **Credenciales hardcodeadas:** la clave de ySocial y las demás no pueden estar en el código ni en
  archivos de configuración **sin cifrar**.
- **Datos en claro en los logs del RPA:** cédula, nombre y correo enmascarados o cifrados.
- **Canal RPA ↔ Sofía con TLS 1.3.**
- **Canal RPA ↔ back office** (ySocial) seguro.
- **API de Sofía:** autenticación, aislamiento de sesiones (un robot o usuario no ve los datos de
  otro) y cifrado.

**Qué tenemos.** Revisión F8 (`docs/security-review.md`): sin credenciales en el código; la clave
de ySocial se guarda cifrada (`Robot.abayaPasswordEncrypted`); `robot.json` del PC protegido con
DPAPI; tokens del robot de 1 h con rotación y detección de reúso; cada operación de la pasarela
verifica que los datos sean del robot del token; logs con redacción de pino; mensajes cifrados.

**Brechas encontradas al preparar este plan (corregir antes de las pruebas):**

| Id  | Brecha                                                                                                                                                                            | Arreglo                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| G1  | En el servidor, `~/rpa/backend/.env` guarda `FIELD_ENCRYPTION_KEY`, `GEMINI_API_KEY` y la contraseña de PostgreSQL **en texto claro** (con permisos 600). Claro lo prohíbe expresamente. | Leer los secretos de la bóveda o PAM al arrancar (R6); el `.env` queda solo con datos no secretos. |
| G2  | nginx con certificado **autofirmado** y sin `ssl_protocols TLSv1.3` explícito.                                                                                                     | `ssl_protocols TLSv1.3;` y certificado de la CA corporativa de Claro (o interna aprobada).         |
| G3  | `scrubText` enmascara teléfonos y documentos pero **no correos** antes de mandar el texto al LLM y a los logs.                                                                    | **Corregido 04/11/2026** (`[CORREO]`, H4 de `security-review.md`).                                                         |
| G4  | Redis sin contraseña (local) y PostgreSQL sin `sslmode=require` (pendiente M5 de la revisión F8).                                                                                 | Contraseña en Redis; si salen de la máquina, TLS en ambos.                                        |
| G5  | Logs del PC del robot: no hay evidencia escrita de que no tengan datos personales.                                                                                                | Escaneo automático de los logs (ver herramientas) y adjuntar el resultado.                        |

**Corregido el 04/11/2026** (`docs/security-review.md`, H1–H5): IP real detrás de nginx (el bloqueo por intentos ya no es compartido), dependencias sin vulnerabilidades conocidas, HSTS, correos enmascarados y `/health` del robot solo local. Pendiente en el servidor: runbook §12.7.

**Pruebas a ejecutar (nosotros):**

1. **Secretos en el código y el historial de git:** gitleaks o trufflehog sobre todo el repo y el
   paquete del robot (`abaya-robot-windows.zip`).
2. **Archivos de configuración del PC:** comprobar que `robot.json` está cifrado con DPAPI y que no
   hay claves en claro en la carpeta de instalación.
3. **Datos personales en los logs:** correr una conversación sintética con cédula, nombre y correo
   conocidos y buscar esos valores en los logs del RPA, del worker y de la API (script de búsqueda:
   debe dar 0).
4. **TLS:** testssl.sh o sslyze contra `https://10.255.255.194` (debe negociar TLS 1.3 y rechazar
   1.0/1.1) y contra `claro-co.ysocial.net` (informar lo que negocia; no lo controlamos).
5. **API de Sofía:** OWASP ZAP sobre `/admin` y `/robot-api` con casos de autenticación (sin
   cookie, token vencido, token de otro robot), aislamiento (robot A pidiendo datos del robot B,
   OPERADOR pidiendo rutas de ADMIN) y CSRF. Muchas ya existen como pruebas automáticas
   (`gateway.int.test.ts`): citarlas en el informe.
6. **Dependencias:** `pnpm audit --prod` y OSV-Scanner. **Código:** Semgrep (reglas de OWASP).

**Recomendado con un proveedor externo:** un **pentest independiente** de la API y la pasarela.
Claro pide un «informe de pruebas»; un informe nuestro sobre nuestro propio sistema puede no
bastarle. Hay que preguntarle a Claro si acepta pruebas internas o exige un tercero (sección 11).

**Evidencias.** `02-pruebas-seguridad/E2.1-informe-RPA.pdf` (nosotros),
`02-pruebas-seguridad/E2.2-informe-API-Sofia.pdf` (nosotros o pentest externo).

## 4. Requerimiento 3 — Logs de auditoría de Sofía

**Qué piden.** Un log **por interacción** con estos campos obligatorios:

| Campo de Claro                         | Qué tenemos hoy                                                    | Falta                                                                       |
| -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Id único de sesión o conversación      | `Conversation.id`                                                  | —                                                                           |
| Número de línea enmascarado            | `customerRefHash` (hash, no enmascarado)                           | Guardar el número enmascarado (`300****567`) si ySocial lo muestra (confirmar) |
| Hora de inicio y fin                   | `Conversation` (apertura y cierre)                                 | Exponerlo en el log                                                         |
| Paso del flujo                         | Etapas de la máquina de estados (MENU, PERFIL, OFERTA, AUTORIZACION, TRANSFERENCIA…) | Tabla de equivalencias con los nombres de Claro (abajo)        |
| Resultado de cada paso                 | Parcial (`RpaActionLog.result`, `LlmCall.validationResult`, tipificación D-025) | Evento por paso: EXITOSO, ERROR o ABANDONO                   |
| Id del asesor del back office          | No se guarda                                                       | Registrar la cola o el asesor al que se transfirió (confirmar qué muestra ySocial) |

**Equivalencia de pasos** (Claro → nuestras etapas):

| Paso de Claro                  | Etapa o evento nuestro                                    |
| ------------------------------ | --------------------------------------------------------- |
| Saludo                         | Turno `opening` y MENU                                    |
| Perfilamiento                  | PERFIL                                                    |
| Oferta                         | OFERTA                                                    |
| Objeciones                     | OFERTA con intención OBJECION                             |
| Lectura de tratamiento de datos | AUTORIZACION (primera y segunda lectura, R4)             |
| Captura de datos               | Datos tras el «SÍ» (`saleData`: documento, nombre, correo) |
| Transferencia                  | TRANSFERENCIA (acción TRANSFER del robot)                 |

**Desarrollo (nosotros).** Una tabla nueva de solo agregar, `InteractionAuditLog` (o una vista
sobre las existentes), con un registro por cambio de paso: conversación, número enmascarado, paso,
resultado, hora, robot y asesor destino. Sin cédula, nombre ni correo; si hace falta referenciarlos,
como hash o referencia cifrada. Exportación a CSV y PDF desde el panel (solo ADMIN, auditada).
Antes, registrar la decisión en `docs/planRPA.md` y `docs/DECISIONS.md` (D-033).

**Evidencias.** `03-logs-auditoria/E3.1-estructura-log.pdf` (diccionario de campos y ejemplo con
datos enmascarados), `03-logs-auditoria/E3.2-logs-RPA.pdf` (muestra de `RpaActionLog` y logs del RPA
de una prueba, enmascarados, con la verificación de la cadena de hashes).

## 5. Requerimiento 4 — Consentimiento explícito en dos lecturas

**Qué piden.** Demostrar que el cliente acepta el tratamiento de datos **antes** de que se capturen
su cédula, nombre y correo, con:

- **Primera lectura:** texto exacto que presenta Sofía.
- **Segunda lectura o confirmación:** texto exacto de la segunda confirmación.
- Textos **aprobados por Cumplimiento de Claro** (fuente: «MAN Criterios para Recolección y
  Tratamiento de Datos Personales» y «Manual de Seguridad IA V0»).
- Cómo acepta el cliente en WhatsApp.
- Log de consentimiento por sesión: hora, sesión y respuesta del cliente, **de las dos lecturas**.

**Qué tenemos.** Una sola lectura: plantilla `AUTORIZACION` (con `INTRO_AUTORIZACION` opcional).
El consentimiento lo decide el **código**, no el modelo: solo un «SÍ AUTORIZO» explícito (regex);
una respuesta ambigua recibe `CONFIRMAR_AUTORIZACION`; una nota de voz no cuenta
(`AUTORIZACION_POR_ESCRITO`). `ConsentEvidence` guarda el hash del texto mostrado, su versión, la
respuesta cifrada y la hora, en una cadena de hashes. Los datos (`saleData`) se piden solo después
del «SÍ». El texto legal actual es nuestro, **no aprobado por Claro**.

**Desarrollo (nosotros).**

1. Paso nuevo en la máquina de estados: primera lectura → «SÍ» → segunda lectura → «SÍ» → captura
   de datos. Un «NO» en cualquiera de las dos → no se capturan datos y se cierra con su tipificación.
2. Plantilla del sistema nueva para la segunda lectura (D-015: el texto en el panel, no en el código).
3. `ConsentEvidence` con el número de lectura (1 o 2): dos registros por sesión, ambos en la cadena.
4. Pruebas y casos en la suite de evaluación (regla 13).
5. Decisión D-033 o D-034 en `docs/planRPA.md` antes del código.

**De Claro.** Los dos textos aprobados por Cumplimiento. Sin ellos no hay evidencia E4.1 (es el
mismo bloqueante A4 de la revisión F8).

**Evidencias.** `04-consentimiento/E4.1-textos-aprobados.pdf` (Claro),
`04-consentimiento/E4.2-mecanismo-aceptacion.pdf` (capturas de WhatsApp o ySocial con las dos
lecturas y la regla de aceptación), `04-consentimiento/E4.3-logs-consentimiento.pdf` (export de
`ConsentEvidence` de las sesiones de prueba, con la verificación de la cadena).

## 6. Requerimiento 5 — Procedimiento de gestión de incidentes

**Qué piden.** Un procedimiento escrito para Sofía y para Asiste como proveedor, con tipos de
incidente, roles, pasos y escalamiento **Asiste → Claro → Asiste**. Los dos tipos que nombran:
comportamiento anómalo (respuestas incorrectas sistemáticas) y **captura de datos sin
consentimiento**. Fuente: «Anexo de Seguridad de Terceros V5» y «POL Seguridad de la Información y
Ciberseguridad V33» (hay que pedírselos a Claro para alinear plazos y formato).

**Qué tenemos.** Kill switch y pausa por robot (detienen al robot en segundos), alertas
(`ALERT_WEBHOOK_URL`, `CUSTOMER_THREAT`, `ROBOT_OVERLOADED`, `RESPONSE_SLOW`, `ROBOT_TOKEN_REUSE`),
validadores anti-alucinación, Auditoría y Trazabilidad, monitor en vivo (D-032).

**Qué hay que escribir (nosotros).**

- **Clasificación:** severidad 1 a 4 con ejemplos (S1: datos capturados sin consentimiento, fuga
  de datos, credencial comprometida; S2: respuestas erradas sistemáticas, precios inventados,
  transferencias fallidas en serie; S3: robot caído; S4: errores aislados).
- **Detección:** alertas automáticas, monitor en vivo, reportes de Claro o de los asesores.
- **Contención:** kill switch o pausa, revertir la versión del agente o del Brain, rotar
  credenciales, revocar el robot.
- **Reporte a Claro:** canal, contacto y plazo por severidad (S1 en minutos u horas, según el
  anexo de Claro).
- **Análisis y cierre:** causa raíz con Auditoría, `RpaActionLog` y trazas; informe a Claro;
  lecciones aprendidas.
- **Matriz RACI:** líder técnico de Asiste, operador del panel, seguridad de Asiste, contacto de
  seguridad de Claro, dueño del negocio en Claro.

**Evidencia.** `05-incidentes/E5.1-procedimiento-incidentes.pdf`.

## 7. Requerimiento 6 — Inventario de cuentas de servicio y PAM

**Qué piden.** La lista de todas las cuentas de servicio (sistema destino, tipo de credencial,
ambiente, propietario) y la prueba de que sus secretos están en el **PAM corporativo** o en un
sistema aprobado: el **identificador** del secreto, nunca el valor. Además, por cada cuenta, una
ficha estándar y una carta responsiva del propietario técnico en Claro. Y la confirmación de que el
RPA no tiene credenciales en el código.

**Inventario inicial (nosotros):**

| Cuenta                                 | Componente   | Sistema destino            | Tipo de credencial                                | Dónde está hoy                                          | Propietario (?)        |
| -------------------------------------- | ------------ | -------------------------- | ------------------------------------------------- | ------------------------------------------------------- | ---------------------- |
| Usuario robot de ySocial (46441856)    | RPA          | ySocial (Claro)            | Usuario y contraseña                              | PostgreSQL cifrada (`abayaPasswordEncrypted`)           | Claro (dueño de ySocial) |
| Credencial del robot ante la pasarela  | RPA → Sofía  | `/robot-api/v1`            | Token de acceso (1 h) y de renovación             | PC: `robot.json` con DPAPI; servidor: solo el hash      | Asiste                 |
| `GEMINI_API_KEY`                       | Sofía        | API de Google Gemini       | API key                                           | `.env` del servidor **en claro** (G1)                   | Asiste                 |
| `FIELD_ENCRYPTION_KEY`                 | Sofía        | Cifrado de campos          | Clave AES                                         | `.env` del servidor **en claro** (G1)                   | Asiste                 |
| Usuario de PostgreSQL                  | Sofía        | Base de datos              | Usuario y contraseña                              | `.env` del servidor (`DATABASE_URL`) **en claro** (G1)  | Asiste                 |
| Clave de firma de paquetes (Ed25519)   | Despliegue   | Actualizaciones del robot  | Clave privada                                     | Equipo que arma los paquetes (`.secrets/`)              | Asiste                 |
| Clave de despliegue de GitHub          | Despliegue   | Repositorios               | Llave SSH                                         | Servidor `~/.ssh` (la del backend aún de lectura y escritura) | Asiste           |
| `ALERT_WEBHOOK_URL`                    | Sofía        | Slack o Teams              | URL con secreto                                   | `.env` del servidor                                     | Asiste                 |
| Cuenta del BRE                         | BRE          | WhatsApp Business / distribución | ?                                           | Claro                                                   | Claro                  |
| SMSC                                   | —            | —                          | **No aplica** (no usamos SMS)                     | —                                                       | —                      |

**Qué es externo.** El **PAM** (gestor de accesos privilegiados): normalmente el de Claro (por
ejemplo CyberArk) o una bóveda que Claro apruebe (HashiCorp Vault, Azure Key Vault, AWS Secrets
Manager). Nosotros no podemos «demostrar custodia en el PAM» sin que ese sistema exista y nos den
acceso. Lo primero es preguntarle a Claro cuál usa y si nos da acceso.

**Desarrollo (nosotros), cuando haya bóveda.** Al arrancar, la API y el worker leen los secretos
de la bóveda (el `.env` queda sin secretos); rotar `GEMINI_API_KEY`, la contraseña de PostgreSQL
y la clave de cifrado (con `FIELD_ENCRYPTION_PREVIOUS_KEYS`); dejar la clave de GitHub en solo
lectura.

**De Claro.** Ficha estándar y carta responsiva de cada cuenta genérica (proceso corporativo de
Claro); dueño técnico del usuario de ySocial y de la cuenta del BRE.

**Evidencias.** `06-cuentas-servicio/E6.1-inventario.pdf` (nosotros),
`06-cuentas-servicio/E6.2-custodia-PAM.pdf` (ids de los secretos en la bóveda, con el proveedor
o con Claro), `06-cuentas-servicio/E6.3-sin-credenciales-hardcodeadas.pdf` (reporte de gitleaks
sobre el repo y el paquete del robot, de E2.1).

## 8. Requerimiento 7 — Entorno aislado y sin entrenamiento de modelos

**Qué piden.**

- Una **certificación** firmada de que Sofía corre en un entorno aislado y exclusivo para Claro.
- Un **diagrama** que muestre ese aislamiento lógico y físico.
- Una **cláusula contractual** que prohíba usar los datos de Claro para entrenar modelos.
- Si se usan modelos de terceros (nuestro caso: **Gemini de Google**), evidencia contractual de que
  ese tercero tampoco entrena con los datos.

**Qué tenemos.** Servidor 10.255.255.194 y PC EQP4B-77 dedicados al robot (confirmar que el
servidor solo aloja esta solución), base de datos propia, el robot sin acceso a PostgreSQL ni a
Redis («hijo delgado»), datos cifrados. Nosotros no entrenamos modelos: solo usamos la API.

**Qué es externo.**

- **Google (proveedor del LLM).** Hay que entregar sus términos vigentes. Según las condiciones de
  la API de Gemini, en el nivel **de pago** Google no usa los prompts ni las respuestas para mejorar
  sus productos; en el nivel **gratuito** sí puede usarlos. Por eso hay que **confirmar que la clave de
  producción es de una cuenta con facturación** y, para la POC, considerar **Vertex AI** (Google
  Cloud), que tiene compromisos contractuales de no entrenar y opciones de retención mínima.
  Verificar el texto vigente de los términos antes de citarlo.
- **Yoizen (ySocial)** es proveedor de Claro, no nuestro: su contrato lo aporta Claro.

**Del área legal (Asiste y Claro).** La cláusula de no entrenamiento en el contrato o en un otrosí,
y la firma de la certificación por el representante legal de Asiste.

**Evidencias.** `07-aislamiento/E7.1-certificacion-entorno.pdf` (redactamos nosotros y firma el
representante legal), `07-aislamiento/E7.2-diagrama-aislamiento.pdf` (nosotros),
`07-aislamiento/E7.3-clausula-no-entrenamiento.pdf` (legal), `07-aislamiento/E7.4-terminos-proveedor-LLM.pdf`
(términos de Google o contrato de Vertex AI).

## 9. Tecnologías

| Para qué                                | Herramienta                                                                                                    | Por qué                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Diagramas HLS, flujo de datos, aislamiento | **Archify** (ya en uso, `docs/diagramas/`) y Mermaid                                                        | Ya tenemos las fuentes; exporta a imagen y SVG para el PDF                                   |
| Generar los PDF                         | Markdown → HTML → PDF con **Playwright** (`page.pdf()`), o Pandoc                                              | Playwright ya está en el proyecto: sin dependencias nuevas, con plantilla de portada común    |
| Secretos en el código e historial       | **gitleaks** (o trufflehog)                                                                                    | Estándar para «credenciales hardcodeadas»; da un reporte para adjuntar                       |
| Análisis estático                       | **Semgrep** (reglas OWASP y TypeScript)                                                                        | Gratis y con reporte                                                                          |
| Dependencias                            | `pnpm audit --prod`, **OSV-Scanner**                                                                           | Vulnerabilidades conocidas                                                                   |
| TLS                                     | **testssl.sh** o **sslyze**; nginx con `ssl_protocols TLSv1.3`                                                  | Prueba objetiva de la versión, los cifrados y el certificado                                  |
| API (DAST)                              | **OWASP ZAP** + pruebas propias (Vitest, `*.int.test.ts`)                                                      | Autenticación, aislamiento de sesiones, CSRF                                                  |
| Datos personales en logs                | Script propio (Node) que siembra datos sintéticos y los busca en los logs, más `scrubText` con correos           | Evidencia repetible de «0 apariciones»                                                       |
| Bóveda de secretos                      | **PAM de Claro** (p. ej. CyberArk) o HashiCorp Vault / Azure Key Vault / AWS Secrets Manager; DPAPI ya usado en el PC | Lo exige el R6; el PC ya cumple con DPAPI                                             |
| Certificado del servidor                | CA corporativa de Claro (o una interna aprobada), en lugar del autofirmado                                      | Necesario para que TLS 1.3 sea aceptable en la revisión                                       |
| Log de auditoría                        | PostgreSQL (tabla de solo agregar con cadena de hashes, como `RpaActionLog`) y export del panel                 | Mismo patrón que ya pasó la revisión F8                                                       |
| LLM sin entrenamiento                   | Gemini API de pago, o **Vertex AI**                                                                            | Compromiso contractual de no entrenar                                                         |

## 10. Orden de trabajo sugerido

| Semana | Trabajo                                                                                                                                         | Responsable          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1      | Enviar a Claro las preguntas de la sección 11. Inventario de cuentas (E6.1). Procedimiento de incidentes (E5.1). HLS y flujo de datos (E1.1, E1.2). | Nosotros             |
| 1      | Pedir al área legal la cláusula y la certificación (E7.1, E7.3). Confirmar el plan de Gemini o pasar a Vertex AI (E7.4).                        | Gerencia, legal      |
| 2      | Desarrollo: correos en `scrubText` (G3), TLS 1.3 y certificado (G2), log por interacción (E3.1), segunda lectura del consentimiento (R4).        | Nosotros             |
| 2–3    | Bóveda o PAM y sacar los secretos del `.env` (G1); rotar las claves.                                                                             | Nosotros + PAM       |
| 3      | Pruebas de seguridad internas (E2.1, E2.2, E6.3) con las herramientas de la sección 9; pentest externo si Claro lo exige.                        | Nosotros + externo   |
| 3      | Corrida de prueba completa (conversación sintética) para sacar los logs de E3.2 y E4.3.                                                         | Nosotros             |
| 4      | Armar las 7 carpetas en PDF, revisión interna y envío.                                                                                          | Nosotros             |

Cada cambio de código sigue la forma de trabajo: decisión primero en `docs/planRPA.md` y
`docs/DECISIONS.md`, pruebas y suite de evaluación en verde, sin commit hasta que se pida.

## 11. Preguntas para Claro

1. ¿«Sofía» es nuestro agente completo (servidor + LLM) y el «RPA» el robot del PC? ¿Qué es
   exactamente el BRE en este flujo y qué cuenta técnica usa?
2. ¿Nos comparten el HLS de su lado (WhatsApp, yFlow / menú comercial, BRE) para completar E1.1?
3. ¿Aceptan pruebas de seguridad internas con reporte de herramientas, o exigen un pentest de un
   tercero?
4. ¿Qué PAM o bóveda corporativa debemos usar y cómo se solicita el acceso? ¿Formato de la ficha y
   de la carta responsiva?
5. Textos de la primera y la segunda lectura aprobados por Cumplimiento, y el documento «MAN
   Criterios para Recolección y Tratamiento de Datos Personales».
6. «Anexo de Seguridad de Terceros V5» y «POL Seguridad de la Información y Ciberseguridad V33»:
   contacto, canal y plazos de reporte de incidentes.
7. Plazo de retención de conversaciones y datos (hoy `CONVERSATION_RETENTION_DAYS` está vacío).
8. ¿ySocial muestra al robot el número de línea del cliente? ¿Qué identificador de asesor del back
   office se puede registrar al transferir?
9. ¿Pueden emitir un certificado de su CA para el servidor 10.255.255.194?
