# Mapa de pantallas de Abaya

> Estado: **PROVISIONAL — basado en el Abaya simulado.**
> Sin acceso todavía al ambiente de pruebas ni al usuario robot (preguntas 1 y 2 de la sección 14).
> Todo lo marcado con ❓ debe confirmarse en el descubrimiento real de F1.

## Cómo se completa la versión real

1. Entrar al ambiente de pruebas con el usuario robot.
2. `npx playwright codegen <URL>` en `apps/rpa`: login, bandeja, abrir chat, leer, escribir,
   enviar, nota interna, transferir a backoffice, cerrar.
3. Guardar el HTML de cada pantalla en `fixtures/abaya/` **sanitizado** (ver `fixtures/abaya/README.md`).
4. DevTools → Network: identificar XHR/WebSocket de mensajes; guardar ejemplos sanitizados en
   `fixtures/abaya/network/`.
5. Actualizar **solo** `apps/rpa/src/abaya/selectors.ts` y `apps/rpa/src/abaya/network/parsers.ts`,
   apuntar las pruebas de `apps/rpa/test/pages/` a los fixtures reales y ajustar el simulador
   (`apps/rpa/test/mock-abaya/`) para que imite el markup real.

## Supuestos actuales (simulador)

| Tema                        | Supuesto en el simulador                                                                                                                                           | Real                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Login                       | Formulario con campos con etiqueta "Usuario", "Contraseña" y botón "Ingresar". Error en `role=alert`.                                                              | ❓                                                  |
| MFA                         | Campo opcional "Código de verificación" (TOTP).                                                                                                                    | ❓ pregunta 3                                       |
| Señal de sesión viva        | Enlace "Salir" visible (siempre presente con sesión abierta). La lista de chats NO sirve: vacía mide 0 px y se considera oculta.                                   | ❓                                                  |
| Identificación de chat      | Atributo `data-chat-id` en la lista y en el panel de conversación; título "Chat {id}".                                                                             | ❓                                                  |
| Id de mensaje               | Atributo `data-message-id`; en red, campo `id`.                                                                                                                    | ❓ si no existe, la huella usa contenido + posición |
| Remitente                   | `data-sender` = `customer` / `agent` / `system`; en red `sender.type`.                                                                                             | ❓                                                  |
| Hora del mensaje            | `data-timestamp` ISO; en red `sentAt`.                                                                                                                             | ❓ zona horaria                                     |
| No leídos                   | Insignia con `data-unread`.                                                                                                                                        | ❓                                                  |
| Entrada de mensajes por red | `GET /api/chats/{id}/messages` (polling) y WebSocket `/ws` con eventos `message.created`, `chat.assigned`, `chat.removed`.                                         | ❓                                                  |
| Escritura                   | Caja "Escribe un mensaje" + botón "Enviar"; `fill` respeta saltos de línea.                                                                                        | ❓ ¿Enter envía? ¿Shift+Enter?                      |
| Confirmación de envío       | La interfaz pinta el mensaje al instante con id `local-*` (optimista) y luego lo reemplaza por el id del servidor. Solo el id del servidor cuenta como verificado. | ❓ ¿cómo indica Abaya "enviado"?                    |
| Nota interna                | Botón "Nota interna" → diálogo con caja "Nota" → "Guardar nota".                                                                                                   | ❓                                                  |
| Transferencia               | Botón "Transferir" → diálogo con selector "Cola" → "Backoffice ventas" → "Confirmar transferencia". El chat sale de la bandeja.                                    | ❓ preguntas 13 y 14                                |
| Cierre                      | Botón "Cerrar chat".                                                                                                                                               | ❓ pregunta 11                                      |
| Límite de chats simultáneos | —                                                                                                                                                                  | ❓ pregunta 5                                       |
| Expiración de sesión        | El simulador permite forzar la expiración (pruebas de F2).                                                                                                         | ❓ pregunta 4                                       |

## Plantilla de la nota para backoffice

Pendiente de acordar con Claro (pregunta 14). Campos mínimos de la sección 6.5: proceso de venta,
plan elegido, nombre del cliente, operador actual, número a portar o migrar si aplica, fecha y hora
de la autorización (Bogotá), identificador de conversación.
