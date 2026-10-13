# Mapa de pantallas de Abaya

> Estado: **REAL, observado el 09/10/2026** en una grabación de un proceso completo hecho por una
> asesora en producción: login, Disponible, dos casos, venta y no venta, envío de imagen,
> finalizar y desconexión. La grabación tuvo 347 pasos, con capturas, HTML, `.har` y traza.
> Los archivos crudos tienen datos personales y **no se versionan**; aquí solo va la estructura.
> Lo que sigue sin verse en vivo está marcado con ❓.

«Abaya» es **ySocial** (Yoizen), con marca Avaya: la consola del asesor «SMCC Web Agent».

## Direcciones

| Qué                | URL                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Entrada            | `https://claro-co.ysocial.net/Login.aspx?Redirect=~/Default.aspx`. Es el login de supervisores; el asesor pasa a `/agent/`. |
| Consola del asesor | `https://claro-co.ysocial.net/agent/#/`, una aplicación **AngularJS** (clases `ng-*`, rutas con `#`).                       |
| Login del asesor   | `https://claro-co.ysocial.net/agent/#/login`                                                                                |
| API REST           | `https://claro-co.ysocial.net/services/...`                                                                                 |
| Tiempo real        | Azure SignalR: `wss://ysocial.service.signalr.net/client/?...`, negociado con `functions.ysocial.net/api/negotiate`.        |
| Adjuntos           | Azure Blob: `https://ysocial.blob.core.windows.net/claroco/ySocial/Attachments/WhatsApp/...`, con enlace firmado (SAS).     |

El sitio está detrás de **Cloudflare**: la cookie `cf_clearance` aparece en la sesión. ❓ Falta
confirmar que el navegador automatizado no se queda en un desafío de Cloudflare.

## Sesión

- El login del asesor tiene usuario, contraseña y el botón **INGRESAR**, más una barra de progreso.
  No se vio MFA, aunque el menú de perfil tiene «doble factor» (`showTwoFactorDialog`), sin activar
  para este usuario.
- **Cerrar el navegador cierra la sesión del asesor**. Reutilizar `storageState` no sirvió: al
  volver a abrir, pidió login. El robot inicia sesión en cada arranque.
- Mantener viva la sesión: la consola hace `POST /services/agents/keepalive` cada ~minuto.
- Al conectarse: `POST /services/agents/connect` y `GET /services/agents/init`.
- Salir: avatar arriba a la derecha (`img.user-image`) → `a.button-profile` con
  `ng-click="navigation.signOut()"` → **ACEPTAR** → `POST /services/agents/disconnect`.
- Señal de sesión viva: la barra superior, con el nombre del estado (`span.title`) y el avatar.

## Estado del asesor

- El control está arriba a la derecha: nombre del estado y cronómetro, por ejemplo
  «Disponible 00:00:00».
- Al entrar, el estado es **«Login»**. Se cambia con clic en el nombre del estado (`span.title`):
  se abre un menú con `ng-click="navigation.switchStates(state)"`, y cada opción es un
  `div.state-name` con su nombre.
- **Disponible** llama a `POST /services/agents/switchtoavail?id={agentId}`.
- Las pausas son las razones auxiliares de `GET /services/configuration/auxreasons`:
  - 0 Login;
  - 1 Break;
  - 2 Capacitación;
  - 3 Baño;
  - 4 Almuerzo;
  - 5 BackOffice;
  - 6 Retroalimentación;
  - 7 FinTurno;
  - 8 PilotoAsesorIntegral;
  - 9 Callback;
  - 29 MensajesSalientes.
- Elegir una pausa con un caso abierto deja «**Trabajando (Pend. Aux.)**»
  (`switchtopending?auxReason=N`): la pausa entra cuando se finalicen los casos.
- Con un caso asignado, el estado pasa solo a «**Trabajando**».

## Bandeja (casos asignados)

- Sin casos, la pantalla dice «¡NO HAY MENSAJES PARA RESPONDER!» (`div.no-messages`).
- Si hay mensajes sin abrir: «HEY! Usted tiene N mensaje sin responder»
  (`div.has-messages-to-answer`).
- Cada caso asignado es un **botón en la barra superior**: `button.navigation-whatsapp.navigation-bar-button`
  con `ng-click="navigation.markAsRead(msg.message)"`. Clases de estado:
  - `unread`: no leído;
  - `new-case`: sin respuestas del asesor;
  - `selected-message`: el que está abierto;
  - `vim`: importante;
  - `with-activity`: hay mensajes nuevos;
  - `timer-expired`: venció el tiempo.
- Abrir un caso (clic) llama a `POST /services/messaging/markasread?id={messageId}&agentId=...`.
- Llegada de un caso nuevo: sale una ventana **«SMCC Web Agent»** con un aviso, por ejemplo
  «TiendaOnLine - Usuario desbordado por opción de venta», y el botón **ACEPTAR (N)** con cuenta
  regresiva. Se puede aceptar o esperar a que termine. `button.btn.btn-flat.btn-action` contiene
  «ACEPTAR».
- Cambiar de caso: botones de la barra o flechas `main.selectMessageToLeft()` /
  `main.selectMessageToRight()`.

## Caso abierto

- Encabezado: «**Caso #NNNNNNNNNN**». El número del caso es el identificador estable: el robot lo
  usa como `abayaChatId`.
- Mensajes: `div#divCaseConversationItem{messageId}.case-conversation-item.msg-row`, con clase
  **`client`** (cliente) o **`agent`** (respuesta). El id del DOM es el id del mensaje de ySocial.
  - Texto en `span.body-text`; hora como enlace `a.date-case` (`showMessageDetails()`).
  - Las respuestas de botones del cliente se ven como «••• Sí, Autorizo» o
    «••• Hablar con un asesor».
- Panel derecho: perfil del cliente (nombre, celular, casos anteriores), datos del caso
  (servicio, inicio, duración, mensajes) y «Campos adicionales» (Cédula, Cuenta Móvil, Email,
  Nombre del Cliente, Caso de Uso…). Todo con datos personales: el robot no lo lee.
- «CARGAR MENSAJES ANTERIORES» (`caseCtrl.getPreviousMessages()`).

## Escribir y enviar

- Caja: `textarea#textareaActAsChat`, con placeholder «Escriba un mensaje».
- **Enter envía**. La asesora pegó textos con varios saltos de línea y salieron completos (la
  petición lleva `\n`).
- Botón de enviar: `a.social-case-reply-as-chat-send` (`caseCtrl.handleSendClick($event)`).
  Mientras envía se ve `div.social-case-reply-as-chat-send-loading`.
- Botones bajo la caja:
  - adjuntar archivo (`actAsChatAttachFile()`, clip);
  - acortar URLs;
  - respuestas predefinidas (`actAsChatShowPredefinedAnswers()`);
  - voz a texto;
  - emojis.
- **Imagen con texto**: la asesora la **pegó** en la caja (`image.png`) y escribió el texto, que
  viajó como pie de foto. Flujo de red:
  1. `GET /services/agents/storage/createsastoken`;
  2. `PUT` del archivo al blob;
  3. `addmessage` con `attachments[0] = { MimeType, FileName, FileSize, AzureUploaded: true, AzureBlobName }`.
- **Cómo funciona el «pegar»** (código de la consola): un manejador global recorre
  `clipboardData.items`; si hay texto y el destino acepta texto, es texto; cada archivo va a
  `caseCtrl.actAsChatInfo.attachmentsQueue` con un aviso, y junto al clip aparece «(N)»
  (`span[ng-if*="attachmentsQueue.length"]`). Al enviar sube cada archivo y manda un solo
  `addmessage`. En la caja, la «⊗» de la ventana de adjuntos quita uno (con ACEPTAR).
- **Mensaje con imagen en el caso:** la fila lleva la clase `has-attach`; el pie de foto va en
  `span.body-text` (si no hay texto no se pinta el cuerpo) y la imagen en
  `.attachments-preview .attachment-image img`. El robot verifica así su envío (D-014 fase 2).

### Petición de envío

`POST /services/messaging/addmessage`:

```json
{
  "id": "<caseId>",
  "messageId": "<id del mensaje del cliente que se responde>",
  "agentId": 0,
  "text": "…",
  "socialServiceType": 16,
  "closeCase": false,
  "attachments": [],
  "serviceId": 2,
  "socialUserId": "<teléfono>"
}
```

La respuesta es `{ "Success": true, "Result": <id del mensaje nuevo> }`.

Confirmación de entrega: llega por SignalR `WhatsappMessageStatusChange` con
`Sent` → `Delivered` → `Read`, y también al recargar el caso, donde el mensaje aparece con
`IsReply: true`.

## Finalizar

Hay un botón **FINALIZAR ▾** abajo a la derecha, con dos opciones:

| Opción                         | `ng-click`                                    | Red                                                                       | Se usó en                            |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| **Finalizar**                  | `caseCtrl.actAsChatInfo.finishMessage(false)` | `POST /services/messaging/finish?id=…` `{"closeCase":false}`              | Venta (tras el link de autorización) |
| **Finalizar y cerrar el caso** | `caseCtrl.actAsChatInfo.finishMessage(true)`  | `POST /services/cases/update` (etiquetas) + `finish` `{"closeCase":true}` | No venta                             |

Pasos de cada opción:

1. Sale la confirmación «¿Está seguro que desea finalizar la atención del mensaje?» con **SI** /
   **NO**.
2. Con «cerrar el caso», además se abre **Detalles del caso**:
   - **Observaciones**, texto libre: aquí iría la nota;
   - **Etiquetas**, un árbol `ivh-treeview` con buscador; se marca la casilla de la hoja;
   - **ACEPTAR** (`updateCase()`), que muestra un aviso verde (`toast-success`).
3. El botón del caso desaparece de la barra superior.

### Etiquetas de la cola de la campaña (147 «Servicios Moviles Organica»)

- **Venta:**
  - 1805 «Venta -Ecommerce Móvil Power»;
  - 1806 «Venta-Ecommerce Móvil Masivo».
- **No Venta:**
  - 1272 «Mejor oferta otros operadores»;
  - 1274 «Cliente carrusel < 90 dias»;
  - 1276 «Rechazado por validacion de identidad»;
  - 1277 «Cliente interesado hogar -T&T»;
  - 1280 «Cliente prefiere Prepago»;
  - 1358 «Cliente abandona conversación»;
  - 1807 «Reglas de Negocio - Politicas»;
  - 1808 «Bot Respuesta Autómatica -Ocioso»;
  - 1809 «Caída de IdClaro»;
  - 1810 «Caída de Poliedro».
- **SAC:**
  - 1283 Soporte;
  - 1284 Facturación;
  - 1285 Cambio de plan;
  - 1286 Consulta/PQR;
  - 1287 Detalle plan hogar;
  - 1288 Detalle plan móvil;
  - 1289 Cancelación móvil;
  - 1290 Cancelación hogar;
  - 1291 Retención;
  - 1292 Demora SIM;
  - 1293 Pagos y recargas.

No se vio un botón «Transferir» en la consola del asesor.

## Red: cómo entra un mensaje

1. **Caso nuevo:** la consola consulta `GET /services/messaging/next?id={agentId}` **cada 6 s**.
   - Vacío: `{"Success":true,"Result":{"Messages":[],"SocialUserProfiles":[],"Persons":[]}}`.
   - Con caso: `Messages[0]` es el mensaje asignado, con `ID`, `Body`, `Date`, `Incoming`,
     `PostedBy`, `Queue.ID` y `Parameters.MessageType`.
2. **Mensaje nuevo en un caso abierto:** SignalR `receive` con
   `{ method: "NewMessageFromAssignedCase", moreInfo: { caseId, messageId, inAgentQueues, queueName } }`.
   Solo trae ids. Después la consola agrupa el mensaje con `POST /services/messaging/group`
   `{ messageIdToGroup }` y pide el caso completo.
3. **Caso completo:** `GET /services/messaging/case?id={messageId}&socialUserProfileId=…` devuelve
   `Result.Case` con `ID` (el caso), `Status`, `Queue` y `Messages[]`. Cada mensaje trae:
   - `ID`, `Body`, `Date` (ISO UTC) e `IsReply`;
   - `ReplySource`: 3 = asesor, 10 = bot yFlow;
   - `PostedBy`: el cliente, o null en respuestas;
   - `RepliedBy`;
   - `HasAttach` y `Attachments[]`;
   - `Parameters.MessageType`: 1 = texto, 10 = respuesta de botón o lista.
4. **Mensaje mostrado tras enviar:** `GET /services/messaging/show?id=…` → `Result.Message`.

### Quién escribió

- `IsReply: false` con `PostedBy` → **cliente**.
- `IsReply: true` → respuesta:
  - `ReplySource: 3` → **asesor**, que también es el robot;
  - `ReplySource: 10` → **bot yFlow** (sistema);
  - otro valor → sistema.
- `Incoming` viene `true` en todos los mensajes del caso, así que **no sirve** para saberlo.

### Adjuntos del cliente (D-010, D-011)

Cada adjunto trae:

- `MimeType`, `FileName` y `FileSize`;
- `Url`;
- `Parameters.AzureStorageUrl` (inline) y `AzureStorageUrlAttachment` (descarga).

Son **enlaces firmados de Azure Blob con varios años de vigencia**: se descargan sin las
cookies de la sesión.

❓ En la grabación solo hubo una imagen. Falta ver una **nota de voz**, probablemente
`audio/ogg`, para cerrar D-010 A3b.

## Resuelto

- **Venta → backoffice** (responsable, 09/10/2026): después de que el cliente da sus datos, el
  asesor da **«Finalizar» → «Finalizar»**. La venta pasa a una cola, la conversación se cierra
  para el asesor y queda esperando la siguiente burbuja. No hay botón «Transferir» ni nota aparte.

## Preguntas abiertas

1. **Etiqueta de cada no venta:** qué etiqueta usa el robot según el motivo; la lista de arriba
   es la disponible. Por ahora es provisional en `sel.finish.tags`.
2. **Escalar a un asesor humano:** no se vio cómo se hace. Hoy el robot no toca Abaya y pide
   revisión humana con alerta.
3. **Usuario del robot:** necesita un usuario de asesor propio en ySocial, sin doble factor o con
   TOTP.
4. **Límite de casos simultáneos:** la asesora tuvo dos a la vez.
5. **Cloudflare** con el navegador automatizado.
6. **Bandeja leída del modelo de AngularJS** (`angular.element(btn).scope()`): la consola real
   tiene la información de depuración activa (clases `ng-scope`), así que debería funcionar.
   Confirmarlo en la primera prueba con el usuario del robot.
