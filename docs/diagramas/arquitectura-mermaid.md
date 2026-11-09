# Diagrama de arquitectura (alto nivel)

Componentes del software del agente RPA y cómo se comunican. El robot del PC habla **solo** con la
pasarela del servidor: nunca recibe base de datos, Redis ni claves.

```mermaid
flowchart LR
    %% Personas
    CLIENTE(["Cliente (WhatsApp)"])
    SUPERVISOR(["Supervisor / Administrador"])
    BACKOFFICE(["Backoffice de Claro"])

    %% Externos
    subgraph EXT["Servicios externos"]
        YSOCIAL["Abaya / ySocial<br/>(aplicación web de chats)"]
        LLM["Modelo de lenguaje<br/>(Gemini · Anthropic · OpenAI)"]
        ALERTAS["Canal de alertas<br/>(Slack / Teams)"]
    end

    %% PC del robot
    subgraph PC["PC del robot (Windows)"]
        LANZADOR["Lanzador<br/>versiones lado a lado y reversión"]
        subgraph RPA["Robot (apps/rpa)"]
            SESION["Gestor de sesión<br/>inicio de sesión · horario · pausa"]
            INBOUND["Lector de mensajes<br/>red y pantalla"]
            ACTOR["Ejecutor de acciones<br/>única vía para actuar"]
            SAFETY["Seguridad<br/>apagado de emergencia · verificación del chat"]
            LIVE["Pantalla en vivo<br/>(solo mirar)"]
            UPDATER["Actualizador<br/>paquetes firmados"]
            CHILD["Cliente de la pasarela<br/>configuración cifrada"]
        end
        CHROMIUM["Navegador Chromium"]
    end

    %% Servidor
    subgraph SRV["Servidor de producción (Linux)"]
        NGINX["Servidor web seguro (nginx)"]
        subgraph API["Servicio de administración (apps/api)"]
            GATEWAY["Pasarela de robots<br/>conexión segura y canal en tiempo real"]
            ADMIN["Administración<br/>usuarios · apagado de emergencia · auditoría · monitor"]
            RELEASES["Versiones del robot"]
        end
        PANEL["Panel web<br/>(interfazRPA)"]
        subgraph WORKER["Motor de conversación (apps/worker)"]
            CONV["Conversación<br/>agrupa mensajes y turnos"]
            ENGINE["Motor<br/>máquina de estados · plantillas · validadores"]
            KNOW["Catálogo y bases de conocimiento<br/>búsqueda híbrida"]
            SALES["Ventas<br/>consentimiento · resumen · tipificación"]
            OUTBOX["Envíos y tareas programadas<br/>reactivación · cierres"]
            EVALS["Suite de evaluación"]
        end
        REDIS[("Redis<br/>colas de trabajo · banderas · monitor en vivo")]
        PG[("Base de datos PostgreSQL<br/>datos cifrados · cadena de hashes")]
    end

    %% Flujos de personas
    CLIENTE -- mensajes --> YSOCIAL
    BACKOFFICE -- recibe ventas --> YSOCIAL
    SUPERVISOR -- "conexión segura" --> NGINX

    %% Robot
    LANZADOR --> RPA
    SESION --> CHROMIUM
    ACTOR --> CHROMIUM
    INBOUND --> CHROMIUM
    CHROMIUM -- "opera como un asesor" --> YSOCIAL
    SAFETY -. "revisa antes de cada acción" .-> ACTOR
    INBOUND --> CHILD
    ACTOR --> CHILD
    LIVE --> CHILD
    UPDATER --> CHILD
    CHILD == "conexión segura con credencial del robot" ==> NGINX

    %% Servidor
    NGINX --> GATEWAY
    NGINX --> ADMIN
    NGINX --> PANEL
    GATEWAY --> REDIS
    GATEWAY --> PG
    ADMIN --> REDIS
    ADMIN --> PG
    RELEASES --> PG
    REDIS <--> WORKER
    CONV --> ENGINE
    ENGINE --> KNOW
    ENGINE --> SALES
    SALES --> OUTBOX
    WORKER --> PG
    ENGINE -- "solo redacta" --> LLM
    KNOW -- "búsqueda por significado" --> LLM
    EVALS --> LLM
    WORKER -- "alertas sin datos personales" --> ALERTAS
    ADMIN --> ALERTAS

    classDef persona fill:#ffffff,stroke:#000000,stroke-width:2px,color:#000000
    classDef externo fill:#f2f2f2,stroke:#555555,stroke-width:1px,stroke-dasharray:4 3,color:#000000
    classDef datos fill:#ffffff,stroke:#000000,stroke-width:2px,color:#000000
    class CLIENTE,SUPERVISOR,BACKOFFICE persona
    class YSOCIAL,LLM,ALERTAS externo
    class REDIS,PG datos
```

## Componentes

| Capa | Componente | Responsabilidad |
| --- | --- | --- |
| PC del robot | Robot (`apps/rpa`) y Chromium | Inicia sesión en ySocial, lee mensajes y actúa (escribir, pegar imágenes, transferir, finalizar) solo por el ejecutor de acciones, revisando antes de cada acción el apagado de emergencia y la identidad del chat. |
| PC del robot | Lanzador y actualizador | Arranca el robot, instala versiones firmadas y vuelve a la anterior si la nueva falla. |
| Servidor | Servidor web seguro (nginx) | Conexión cifrada; sirve el panel y dirige las peticiones al servicio de administración. |
| Servidor | Servicio de administración (`apps/api`) | Pasarela de robots, panel de administración, apagado de emergencia, auditoría, monitor en vivo y versiones del robot. |
| Servidor | Motor de conversación (`apps/worker`) | Máquina de estados, plantillas, validadores contra datos inventados, catálogo y bases de conocimiento, ventas, envíos, tareas programadas y suite de evaluación. |
| Servidor | Redis | Colas de trabajo entre procesos (mensajes de entrada, envíos por robot, transferencias, cierres, evaluaciones), banderas de pausa y apagado, y monitor en vivo. |
| Servidor | PostgreSQL | Conversaciones y resúmenes cifrados, catálogo, configuración del agente, consentimientos y registro de acciones con cadena de hashes. |
| Externo | Abaya / ySocial | Aplicación donde el cliente escribe y donde el backoffice recibe la venta. |
| Externo | Modelo de lenguaje | Redacta las respuestas y apoya la búsqueda en el catálogo; no decide el flujo. |
