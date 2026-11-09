# Diagrama de proceso — Atención de un chat de ventas por el robot

Flujo de negocio de un caso asignado al robot en Abaya (ySocial), desde la asignación hasta la
transferencia al backoffice o el cierre. Símbolos clásicos: óvalo = inicio/fin, rectángulo = actividad,
rombo = decisión, paralelogramo = dato, rectángulo doble = subproceso.

```mermaid
flowchart TD
    INICIO(["Inicio: caso asignado al robot en Abaya"])
    VERIF["Verificar identidad del chat"]
    SALUDO["Enviar saludo con el menú"]
    RESP1{"¿El cliente responde?"}
    REACT["Enviar reactivación (cada 2 min)"]
    INTENTOS{"¿Van 3 reactivaciones?"}
    CIERRE_ABANDONO["Cerrar: «Cliente abandona conversación»"]

    MENU{"Opción del menú"}
    OPERADOR{"¿Operador actual?"}
    POSPAGO["Plantilla: ya es pospago"]
    PORTA["Proceso Portabilidad"]
    MIGRA["Proceso Migración"]
    AYUDA["Preguntar: ¿en qué te puedo ayudar?"]
    NECESIDAD{"¿Qué necesita?"}
    CONSULTA[["Consulta de portabilidad (caso de servicio)"]]
    SOLO_VENTAS["Plantilla: chat exclusivo de ventas"]

    PERFIL["Perfilar: uso de la línea y red"]
    OFERTA["Ofrecer planes del catálogo (imágenes)"]
    ACEPTA{"¿Elige un plan?"}
    DUDAS["Resolver dudas y ajustar la oferta"]
    LEGAL["Enviar texto legal (plantilla)"]
    AUTORIZA{"¿Responde «SÍ AUTORIZO»?"}
    CONSENT[/"Registrar consentimiento"/]
    DATOS["Pedir datos: documento, nombre y correo"]
    COMPLETOS{"¿Datos completos?"}
    TRANSFER["Transferir al backoffice con nota interna"]
    FIN_VENTA(["Fin: venta en backoffice"])

    TIPIFICAR["Tipificar el cierre"]
    CIERRE_SIN_VENTA["Finalizar el chat con su etiqueta"]
    FIN_SIN_VENTA(["Fin: sin venta"])

    INICIO --> VERIF --> SALUDO --> RESP1
    RESP1 -- No --> REACT --> INTENTOS
    INTENTOS -- No --> RESP1
    INTENTOS -- Sí --> CIERRE_ABANDONO --> FIN_SIN_VENTA
    RESP1 -- Sí --> MENU

    MENU -- "A: Portabilidad" --> OPERADOR
    OPERADOR -- "Otro operador" --> PORTA
    OPERADOR -- "Claro prepago" --> MIGRA
    OPERADOR -- "Claro pospago" --> POSPAGO --> MENU
    MENU -- "B: Migración" --> MIGRA
    MENU -- "C / D" --> AYUDA --> NECESIDAD
    NECESIDAD -- "Comprar" --> MENU
    NECESIDAD -- "Estado de su portabilidad" --> CONSULTA --> FIN_SIN_VENTA
    NECESIDAD -- "Otro tema" --> SOLO_VENTAS --> TIPIFICAR

    PORTA --> PERFIL
    MIGRA --> PERFIL
    PERFIL --> OFERTA --> ACEPTA
    ACEPTA -- "Tiene dudas" --> DUDAS --> ACEPTA
    ACEPTA -- No --> TIPIFICAR
    ACEPTA -- Sí --> LEGAL --> AUTORIZA
    AUTORIZA -- No --> TIPIFICAR
    AUTORIZA -- Sí --> CONSENT --> DATOS --> COMPLETOS
    COMPLETOS -- No --> DATOS
    COMPLETOS -- "Sí, o 3 mensajes sin datos nuevos" --> TRANSFER --> FIN_VENTA

    TIPIFICAR --> CIERRE_SIN_VENTA --> FIN_SIN_VENTA

    classDef terminal fill:#ffffff,stroke:#000000,stroke-width:2px,color:#000000
    classDef actividad fill:#ffffff,stroke:#000000,stroke-width:1px,color:#000000
    classDef decision fill:#f2f2f2,stroke:#000000,stroke-width:1px,color:#000000
    class INICIO,FIN_VENTA,FIN_SIN_VENTA terminal
    class VERIF,SALUDO,REACT,CIERRE_ABANDONO,POSPAGO,PORTA,MIGRA,AYUDA,SOLO_VENTAS,PERFIL,OFERTA,DUDAS,LEGAL,DATOS,TRANSFER,TIPIFICAR,CIERRE_SIN_VENTA,CONSULTA,CONSENT actividad
    class RESP1,INTENTOS,MENU,OPERADOR,NECESIDAD,ACEPTA,AUTORIZA,COMPLETOS decision
```

## Reglas que muestra el diagrama

- El robot verifica la identidad del chat antes de escribir.
- El camino lo decide la máquina de estados (el flujo del agente en el panel); el modelo solo redacta.
- Precios y planes salen del catálogo publicado; el texto legal es una plantilla.
- Solo un «SÍ AUTORIZO» explícito cuenta como consentimiento, y queda registrado con cadena de hashes.
- Migración: uso → red. Portabilidad: operador → uso → red. Línea nueva solo si el cliente la pide.
- Los datos que faltan se piden cuando el cliente deja de escribir (45 s); tras 3 mensajes sin datos
  nuevos la venta se transfiere igual.
