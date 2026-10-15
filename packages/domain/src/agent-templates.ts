/**
 * D-013: plantillas de respuesta del agente (hoja «Plantillas» del Excel «Plantillas SMCC» de la
 * campaña, celdas en verde). Los asesores contestan con ellas; el robot también: el modelo
 * elige CUÁL usar con el marcador {{PLANTILLA:id}} y el código inserta el texto exacto.
 *
 * Se versionan con el agente (se editan en el panel → Configuración → Plantillas).
 */

/**
 * Qué hace el sistema con cada plantilla:
 * - RESPUESTA: el modelo la elige según la conversación ({{PLANTILLA:id}}).
 * - INTRO_AUTORIZACION: va justo antes del texto de autorización (validación de cupo).
 * - AUTORIZACION: texto legal de autorización (exactamente una). El código la envía al aceptar
 *   un plan, con la fecha del día.
 * - SOLICITUD_DATOS: tras el «SÍ», pide los datos del cliente; con su respuesta se finaliza.
 * - DESPEDIDA_NO_VENTA: cierre cuando no hay venta.
 * - REACTIVACION: si el cliente deja de responder, se envían en orden con los tiempos de la
 *   configuración.
 * - REFERENCIA: guardada para consulta; el robot nunca la envía (p. ej. lo que hace el
 *   backoffice en sistemas de Claro: links, PIN, biometría, activación).
 * - D-015, plantillas del sistema (SYSTEM_TEMPLATE_ROLES): textos que antes estaban fijos en el
 *   código (soporte, escalar, transferencia, respuesta segura, espera…).
 */
export const TEMPLATE_ROLES = [
  'RESPUESTA',
  'INTRO_AUTORIZACION',
  'AUTORIZACION',
  'SOLICITUD_DATOS',
  'DESPEDIDA_NO_VENTA',
  'REACTIVACION',
  'REFERENCIA',
  // D-015: plantillas del sistema.
  'SOPORTE',
  'PREGUNTA_NECESIDAD',
  'ESCALAR',
  'RESPUESTA_SEGURA',
  'ESPERA',
  'TRANSFERENCIA',
  'NO_AUTORIZA',
  'ASESOR_TRAS_NO_AUTORIZAR',
  'CONFIRMAR_AUTORIZACION',
  'AUTORIZACION_POR_ESCRITO',
  'NOTA_DE_VOZ_ILEGIBLE',
  'DATOS_FALTANTES',
  'YA_POSPAGO',
  // D-023: consulta de una portabilidad ya solicitada.
  'PORTABILIDAD_CONFIRMACION',
  'PORTABILIDAD_CONFIRMADA',
  'PORTABILIDAD_VALIDAR',
  'PORTABILIDAD_TRANSFERENCIA',
] as const;
export type TemplateRole = (typeof TEMPLATE_ROLES)[number];

/**
 * D-015: plantillas del sistema. El código las envía en un punto fijo del flujo, sin pasar por el
 * modelo; si una versión del agente no tiene alguna, se usa la de `DEFAULT_TEMPLATES` (el texto que
 * antes estaba en el código). Todas son de una sola plantilla salvo ESPERA (se rotan).
 */
export const SYSTEM_TEMPLATE_ROLES = [
  'SOPORTE',
  'PREGUNTA_NECESIDAD',
  'ESCALAR',
  'RESPUESTA_SEGURA',
  'ESPERA',
  'TRANSFERENCIA',
  'NO_AUTORIZA',
  'ASESOR_TRAS_NO_AUTORIZAR',
  'CONFIRMAR_AUTORIZACION',
  'AUTORIZACION_POR_ESCRITO',
  'NOTA_DE_VOZ_ILEGIBLE',
  'DATOS_FALTANTES',
  'YA_POSPAGO',
  // D-023: consulta de una portabilidad ya solicitada.
  'PORTABILIDAD_CONFIRMACION',
  'PORTABILIDAD_CONFIRMADA',
  'PORTABILIDAD_VALIDAR',
  'PORTABILIDAD_TRANSFERENCIA',
] as const satisfies readonly TemplateRole[];
export type SystemTemplateRole = (typeof SYSTEM_TEMPLATE_ROLES)[number];

export const isSystemTemplateRole = (role: string): role is SystemTemplateRole =>
  (SYSTEM_TEMPLATE_ROLES as readonly string[]).includes(role);

/** Roles de los que solo puede haber una plantilla. */
export const SINGLE_TEMPLATE_ROLES: readonly TemplateRole[] = [
  'INTRO_AUTORIZACION',
  'AUTORIZACION',
  'SOLICITUD_DATOS',
  'DESPEDIDA_NO_VENTA',
  ...SYSTEM_TEMPLATE_ROLES.filter((r) => r !== 'ESPERA'),
];

export interface AgentTemplate {
  /** Identificador estable (minúsculas, números y guiones): va en {{PLANTILLA:id}}. */
  id: string;
  /** Sección de la hoja (Perfilamiento, Todo Claro, Reactivación…). */
  group: string;
  title: string;
  role: TemplateRole;
  /** Para RESPUESTA: cuándo usarla (se le da al modelo). */
  when: string;
  /** Texto exacto. Variables: {nombre_agente}, {nombre_cliente}, {fecha}. */
  text: string;
}

export interface ReactivationConfig {
  /** Minutos de silencio del cliente antes de cada mensaje de reactivación. */
  minutes: number;
  /** Cuántos mensajes de reactivación como máximo; después se cierra por inactividad. */
  max: number;
}

export const TEMPLATE_LIMITS = {
  count: 80,
  id: 40,
  group: 60,
  title: 80,
  when: 300,
  text: 1_200,
  reactivationMinutesMin: 1,
  reactivationMinutesMax: 120,
  reactivationMaxMax: 10,
} as const;

export const TEMPLATE_VARIABLES = [
  'nombre_agente',
  'nombre_cliente',
  'fecha',
  // DATOS_FALTANTES: lo que falta de los datos de la venta («tu correo electrónico»).
  'datos_faltantes',
] as const;

export const TEMPLATE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Marcador que escribe el modelo; el código lo reemplaza por el texto de la plantilla. */
export const TEMPLATE_MARKER_RE = /\{\{PLANTILLA:([a-z0-9]+(?:-[a-z0-9]+)*)\}\}/g;

// Campaña (09/10/2026): una plantilla distinta cada 2 minutos, 3 intentos; luego «cliente abandona».
export const DEFAULT_REACTIVATION: ReactivationConfig = { minutes: 2, max: 3 };

/** Fecha de Bogotá como en las plantillas de la campaña: 21/07/2026. */
export function bogotaShortDate(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year}`;
}

export interface TemplateVars {
  agentName: string;
  customerName?: string | undefined;
  now: Date;
  /** DATOS_FALTANTES: lo que falta, ya redactado («tu nombre completo y tu correo electrónico»). */
  missingData?: string | undefined;
}

/**
 * Texto final de la plantilla con sus variables. Sin nombre del cliente, la variable se omite junto
 * con la coma que la antecede («¡Gracias, {nombre_cliente}!» → «¡Gracias!»).
 */
export function renderTemplate(text: string, v: TemplateVars): string {
  return text
    .replace(/\{nombre_agente\}/g, v.agentName)
    .replace(/\{fecha\}/g, bogotaShortDate(v.now))
    .replace(/\{datos_faltantes\}/g, v.missingData ?? '')
    .replace(/(,?)\s*\{nombre_cliente\}/g, (_m, comma: string) =>
      v.customerName ? `${comma} ${v.customerName}` : '',
    )
    .trim();
}

export function templatesByRole(
  templates: readonly AgentTemplate[],
  role: TemplateRole,
): AgentTemplate[] {
  return templates.filter((t) => t.role === role);
}

export function templateByRole(
  templates: readonly AgentTemplate[],
  role: TemplateRole,
): AgentTemplate | undefined {
  return templates.find((t) => t.role === role);
}

// ---------- hoja «Plantillas» (celdas verdes), digitalizada el 09/10/2026 ----------

const t = (
  id: string,
  group: string,
  title: string,
  role: TemplateRole,
  when: string,
  text: string,
): AgentTemplate => ({ id, group, title, role, when, text });

const BACKOFFICE =
  'La envía el asesor del backoffice: implica generar un link o una validación en los sistemas de Claro.';

export const DEFAULT_TEMPLATES: AgentTemplate[] = [
  // Saludo
  t(
    'saludo-5g',
    'Saludo',
    'Saludo de campaña 5G',
    'REFERENCIA',
    'Saludo de mensajes salientes de campaña; el chat entrante empieza con el saludo y el menú.',
    '¡Es una realidad! #Llego_5G_a_Claro🤩📶\n¡ESTIMADO CLIENTE! 😃 Te escribe {nombre_agente} analista comercial del área de activación y ventas de Claro Móvil.🔴',
  ),
  t(
    'saludo-menu',
    'Saludo',
    'Saludo con el menú',
    'REFERENCIA',
    'El saludo con el menú A–D lo envía el sistema: se edita en «Saludo» de la configuración.',
    '¡Hola! Con Claro lo puedes todo. \n💪📱Mi nombre es {nombre_agente}.\n\n🎄✨ ¡En esta Navidad armamos el arbolito por ti! 🎅 Con tu plan Claro Móvil accede a beneficios exclusivos de Bienestar y asistencia para tu hogar. ¡Pregúntame cómo obtener este beneficio! \n\n📲  Elige una de nuestras opciones:\n🅐 Cambiarme de operador\n🅑 Pasarme de recargas a plan pospago\n🅒 Ya tengo plan: soporte, factura o cambio\n🅓 Cancelar mi plan pospago',
  ),
  t(
    'saludo-asesoria',
    'Saludo',
    '¿En qué te puedo asesorar?',
    'RESPUESTA',
    'El cliente saluda o escribe algo general sin decir qué necesita.',
    'Hola para mi es un gusto saludarte cuéntame ¿en qué te puedo asesorar el día de hoy?',
  ),
  t(
    'ya-pospago',
    'Saludo',
    '¿Ya eres pospago?',
    'RESPUESTA',
    'Hay que saber si el cliente ya tiene un plan pospago con Claro.',
    '¿Ya haces parte de Claro postpago?',
  ),
  t(
    'recargas-a-pospago',
    'Saludo',
    'De recargas a pospago',
    'RESPUESTA',
    'El cliente usa recargas (prepago): explicarle por qué le conviene un plan pospago antes de perfilarlo.',
    'Por este medio podemos ayudarte con un plan pospago, que hoy puede salirte más económico que las recargas.\n\nTenemos un plan con descuento, con más datos, minutos ilimitados y un valor fijo mensual, para que no te quedes sin servicio ni tengas que recargar constantemente.\n\nSi quieres, te cuento la opción que mejor se ajusta a tu consumo 😊',
  ),
  // Perfilamiento
  t(
    'perfil-operador',
    'Perfilamiento',
    '¿Con qué operador estás?',
    'RESPUESTA',
    'Cambio de operador (portabilidad): falta saber con qué operador está.',
    'Claro que sí, cuéntame ¿con que operador manejas tu línea móvil?',
  ),
  t(
    'perfil-uso',
    'Perfilamiento',
    'Uso del plan (con «Claro que sí»)',
    'RESPUESTA',
    'Falta saber para qué usará el plan y el cliente acaba de dar un dato.',
    'Claro que sí, cuéntame ¿ El plan lo vas a utilizar mayor mente con fines laborales, estudiantiles o de uso diario?',
  ),
  t(
    'perfil-uso-directo',
    'Perfilamiento',
    'Uso del plan',
    'RESPUESTA',
    'Falta saber para qué usará el plan.',
    '¿ El plan lo vas a utilizar mayor mente con fines laborales, estudiantiles o de uso diario?',
  ),
  t(
    'perfil-redes',
    'Perfilamiento',
    'Red social que más usa',
    'RESPUESTA',
    'Para recomendar el plan: saber qué plataforma o red social usa más.',
    '¿Tienes alguna plataforma o red social que utilices con mayor frecuencia?',
  ),
  t(
    'perfil-voz-datos',
    'Perfilamiento',
    '¿Llamadas o datos?',
    'RESPUESTA',
    'Para recomendar el plan: saber si usa más llamadas o datos.',
    'Perfecto, para encontrar la mejor opción para ti te hago una pregunta ¿Haces uso mayormente del servicio de telefonía o de datos?',
  ),
  // Todo Claro
  t(
    'todo-claro-pregunta',
    'Todo Claro',
    '¿Tienes Claro hogar?',
    'RESPUESTA',
    'Antes de ofrecer: saber si tiene servicios de Claro hogar (beneficio Todo Claro).',
    '¿haces uso de algún servicio de Claro hogar en tu residencia o a tu nombre ya sea telefonía fija Wi/fi o televisión?',
  ),
  t(
    'todo-claro-si',
    'Todo Claro',
    'Es cliente hogar',
    'RESPUESTA',
    'El cliente SÍ tiene servicios de Claro hogar.',
    'Por ser cliente del hogar con Claro  🏡podrás recibir G.B adicionales de navegación en tu servicio móvil📱 y megas en tu hogar convirtiéndote un cliente TODO CLARO activando tu plan postpago el día de hoy🤩',
  ),
  t(
    'todo-claro-futuro',
    'Todo Claro',
    'No es cliente hogar',
    'RESPUESTA',
    'El cliente NO tiene servicios de Claro hogar.',
    'Para una futura contratación ten presente que por ser cliente del hogar con Claro 🏡podrás recibir G.B adicionales de navegación en tu servicio móvil📱 y megas en tu hogar convirtiéndote un cliente TODO CLARO activando tu plan postpago el día de hoy🤩¿Te gustaría conocer las ofertas que tenemos disponibles para tu hogar?',
  ),
  // Descuentos
  t(
    'descuentos-portabilidad',
    'Descuentos',
    'Opciones de descuento por portabilidad',
    'RESPUESTA',
    'Portabilidad: presentar las opciones de descuento. Solo si el catálogo del plan tiene esos mismos descuentos.',
    'Por el proceso de portabilidad te puedo otorgar cualquiera de estas 2 opciones\n✅Descuento del 25% en la 1 y 2 facturación\n✅Descuento del 20% en la 1,2,3,4 y 5 facturación',
  ),
  // Descripción del plan
  t(
    'plan-ejemplo',
    'Descripción del plan',
    'Ejemplo de descripción de un plan',
    'REFERENCIA',
    'Ejemplo de formato: el robot describe los planes con los datos del catálogo publicado ({{OFERTA:CÓDIGO}}).',
    '👉🏻 MINUTOS Y MENSAJES ILIMITADOS a cualquier operador y destino nacional en Colombia. 📲\n👉🏻 60 GB DE NAVEGACIÓN en internet, puedes tambien compartir de esas mismas 60 GB internet. 🤩\n👉🏻 REDES SOCIALES ILIMITADAS (WhatsApp, Facebook, Twitter.) sin consumo de datos🔓🫣\n👉🏻 CLARO VIDEO (5 pantallas gratis durante 12 meses) y CLARO MUSICA. 🎞️\nCargo fijo mensual cerrado: $44.900 impuestos IVA todo incluido',
  ),
  // Solicitud de datos
  t(
    'validacion-cupo',
    'Solicitud de datos',
    'Validación de cupo',
    'INTRO_AUTORIZACION',
    'Va justo antes de la autorización, cuando el cliente acepta un plan.',
    'El proceso es muy sencillo, en primer lugar, debemos validar que cuentes con el cupo disponible para la activación del servicio para esto vamos a realizar una consulta ante Claro Móvil',
  ),
  t(
    'autorizacion',
    'Solicitud de datos',
    'Autorización de consulta (habeas data)',
    'AUTORIZACION',
    'La envía el sistema al aceptar un plan, con la fecha del día. El cliente responde Sí o No.',
    'Sr(a) con el fin de continuar con la propuesta comercial de los servicios de MÓVIL  informado, hoy {fecha}, autoriza a CLARO, para consultar sus datos personales ante cualquier entidad de información con el fin de validar su comportamiento y crédito comercial, hábito de pago y en general el cumplimiento de sus obligaciones comerciales y pecuniarias, así como el tratamiento de sus datos personales, según lo dispuesto en la ley 1266 de 2008 y Ley 1581 de 2012.  ¿Acepta Ud.?   Sí / No',
  ),
  t(
    'solicitud-datos',
    'Solicitud de datos',
    'Pedir los datos del cliente',
    'SOLICITUD_DATOS',
    'Tras el «Sí» a la autorización. Cuando el cliente envía sus datos, el robot finaliza y la venta pasa al backoffice.',
    'Sr(a)  me confirma su número de documento de identidad, nombre completo, número celular y correo electrónico para enviar el documento digital para esta aceptación.',
  ),
  // Plantillas de auto-digitación (backoffice)
  t(
    'habeas-data-link',
    'Auto-digitación',
    'Habeas Data: link de autorización',
    'REFERENCIA',
    BACKOFFICE,
    '* Te genere el envió de un link por medio de mensaje de texto o correo electrónico para que me autorices el tratamientos de tus datos personales, por favor ingresa  al link y le vas a dar Click en la opción de Aceptar ✅para continuar',
  ),
  t(
    'contrato',
    'Auto-digitación',
    'Contrato digital',
    'REFERENCIA',
    BACKOFFICE,
    '* Con el fin de rectificar los servicios que estas contratando con Claro, te voy a generar el envió de tu contrato digital donde podrás validar las características generar del servicio contrato, por favor ingresa al link que te acaba de llegar por mensaje de texto o correo y por favor le vas a dar Click en la casilla de Aceptar ✅',
  ),
  t(
    'validacion-pin',
    'Validación de identidad',
    'PIN de 4 dígitos',
    'REFERENCIA',
    BACKOFFICE,
    '** En este momento con el fin de validar tu identidad te genere el envió de un pin de 4 dígitos por medio de mensaje de texto, por favor me confirmas el código que recibiste',
  ),
  t(
    'validacion-biometria',
    'Validación de identidad',
    'Biometría facial',
    'REFERENCIA',
    BACKOFFICE,
    'Te genere el envio de un link de validación facial, por favor ingresa y sigue los pasos que te indique el aplicativo',
  ),
  t(
    'activacion-migracion',
    'Activación',
    'Activación de migración',
    'REFERENCIA',
    BACKOFFICE,
    'Tu linea se encuentra activa correctamente, ya solo restan 10 minuto para que puedas empezar a disfrutar de los servicios contratados el día de hoy, para nosotros es un gusto que nos hubieses escogido como tu operador, esperamos que sigas disfrutando de los beneficios que tenemos disponibles para ti🤩📶',
  ),
  // Despedida
  t(
    'despedida-claro-pay',
    'Despedida',
    'Despedida con Claro Pay',
    'RESPUESTA',
    'El cliente se despide o agradece al final y no hay nada más pendiente.',
    'Gracias por su atención, recuerde que ahora con Claro Pay puedes enviar y recibir dinero, pagar en comercios y mucho más, todo es gratis y al instante desde tu celular, descarga la App. Esto lo hacemos por ti y es tan solo el comienzo 🤑📶',
  ),
  t(
    'despedida-no-venta',
    'Despedida',
    'Despedida sin venta',
    'DESPEDIDA_NO_VENTA',
    'La envía el sistema al cerrar una conversación sin venta.',
    'Gracias por comunicarte con el área de ventas de Claro móvil para mí fue un gusto ayudarte el día de hoy, hasta una próxima oportunidad😀',
  ),
  // Reactivación
  t(
    'reactivacion-promociones',
    'Reactivación',
    '¡No te pierdas las promociones!',
    'REACTIVACION',
    '',
    '¡No te pierdas las promociones! Confírmame si continúas en línea 👀',
  ),
  t(
    'reactivacion-sigues-ahi',
    'Reactivación',
    '¿Sigues ahí?',
    'REACTIVACION',
    '',
    'Déjanos asesorarte ¿sigues ahí? 👀',
  ),
  t(
    'reactivacion-agendar-llamada',
    'Reactivación',
    'Agendar una llamada',
    'REACTIVACION',
    '',
    '¿Te ocupaste? Agendemos una llamada y confírmame tú número',
  ),
  t(
    'reactivacion-agilizar',
    'Reactivación',
    '¿Te puedo llamar?',
    'REACTIVACION',
    '',
    'Queremos agilizar tu compra ¿te puedo llamar? 📲',
  ),
  t(
    'reactivacion-a-un-si',
    'Reactivación',
    'A un SÍ de finalizar',
    'REACTIVACION',
    '',
    'Estamos a un SÍ de finalizar tu compra ¿nos contactamos por llamada? 📲',
  ),
  t(
    'reactivacion-tiempo-corre',
    'Reactivación',
    'El tiempo corre',
    'REACTIVACION',
    '',
    '¡El tiempo corre ⏳ y tu compra espera! ¿te podemos llamar? 📲',
  ),
  // D-015: plantillas del sistema (antes, textos fijos del código; mismo texto por defecto).
  t(
    'soporte-chat-ventas',
    'Sistema',
    'Chat exclusivo de ventas',
    'SOPORTE',
    'La envía el sistema cuando el mensaje no es una compra (servicio al cliente, factura, soporte, cancelación). El chat sigue abierto.',
    'En este momento no cuento con las herramientas para ayudarte con eso, ya que este es un chat exclusivo de ventas de planes pospago. Puedes comunicarte al *611 desde tu celular Claro, en Bogotá al 6017500500 o a nivel nacional al 018003200200. ¿Te puedo ayudar con algún plan móvil?',
  ),
  t(
    'pregunta-necesidad',
    'Sistema',
    '¿En qué te puedo ayudar?',
    'PREGUNTA_NECESIDAD',
    'La envía el sistema cuando el cliente elige una opción del menú que lleva a «preguntar qué necesita».',
    'Claro que sí, cuéntame ¿en qué te puedo ayudar?',
  ),
  t(
    'escalar-asesor',
    'Sistema',
    'Paso a un asesor',
    'ESCALAR',
    'La envía el sistema al pasar la conversación a un asesor humano.',
    'Gracias por tu mensaje. Te voy a comunicar con un asesor de nuestro equipo que podrá ayudarte mejor con esto. Por favor espera un momento.',
  ),
  t(
    'respuesta-segura',
    'Sistema',
    'Respuesta segura',
    'RESPUESTA_SEGURA',
    'La envía el sistema cuando la respuesta del modelo no pasa la validación dos veces.',
    'Déjame confirmarte ese detalle para darte la información correcta. ¿Me lo puedes repetir, por favor?',
  ),
  t(
    'espera-un-momento',
    'Sistema',
    'Dame un momento',
    'ESPERA',
    'Si el cliente lleva un rato esperando respuesta, el sistema envía estas rotando.',
    'Dame un momento, por favor, ya te respondo 🙏',
  ),
  t(
    'espera-sigo-aqui',
    'Sistema',
    'Sigo aquí contigo',
    'ESPERA',
    'Si el cliente lleva un rato esperando respuesta, el sistema envía estas rotando.',
    'Sigo aquí contigo 😊 Estoy revisando la información para darte la respuesta correcta.',
  ),
  t(
    'espera-gracias-paciencia',
    'Sistema',
    'Gracias por tu paciencia',
    'ESPERA',
    'Si el cliente lleva un rato esperando respuesta, el sistema envía estas rotando.',
    'Gracias por tu paciencia 🙌 En un momento te respondo.',
  ),
  t(
    'transferencia-backoffice',
    'Sistema',
    'Transferencia al backoffice',
    'TRANSFERENCIA',
    'La envía el sistema al pasar la venta autorizada al backoffice.',
    '¡Gracias, {nombre_cliente}! Te transfiero con uno de nuestros asesores para finalizar tu solicitud. 🚀',
  ),
  t(
    'no-autoriza',
    'Sistema',
    'No autoriza',
    'NO_AUTORIZA',
    'La envía el sistema si el cliente responde NO a la autorización (se le ofrece un asesor).',
    'Entiendo, {nombre_cliente}. Sin esta autorización no podemos continuar con la contratación. ¿Quieres que un asesor te resuelva las dudas que tengas sobre este paso?',
  ),
  t(
    'asesor-tras-no-autorizar',
    'Sistema',
    'Asesor tras no autorizar',
    'ASESOR_TRAS_NO_AUTORIZAR',
    'La envía el sistema si, después de no autorizar, el cliente acepta hablar con un asesor.',
    '¡Con gusto, {nombre_cliente}! Te comunico con uno de nuestros asesores para resolver tus dudas. 🚀',
  ),
  t(
    'confirmar-autorizacion',
    'Sistema',
    'Confirmar la autorización',
    'CONFIRMAR_AUTORIZACION',
    'La envía el sistema si la respuesta a la autorización es ambigua (solo vale un SÍ o un NO explícito).',
    'Para continuar necesito tu confirmación. Por favor responde *SI* si autorizas o *NO* si prefieres no autorizar.',
  ),
  t(
    'autorizacion-por-escrito',
    'Sistema',
    'Autorización por escrito',
    'AUTORIZACION_POR_ESCRITO',
    'La envía el sistema si el cliente autoriza en una nota de voz: la autorización solo vale escrita.',
    'Gracias 🙌 Para dejar constancia de tu autorización necesito que me la escribas: responde *SI* por escrito si autorizas o *NO* si prefieres no autorizar.',
  ),
  t(
    'datos-faltantes',
    'Sistema',
    'Datos que faltan',
    'DATOS_FALTANTES',
    'La envía el sistema después del «SÍ» si aún faltan datos del cliente para pasar la venta (lo que falta va en {datos_faltantes}).',
    '¡Gracias! Para finalizar tu solicitud me falta {datos_faltantes}. ¿Me lo compartes, por favor?',
  ),
  t(
    'sistema-ya-pospago',
    'Sistema',
    'Ya es pospago',
    'YA_POSPAGO',
    'La envía el sistema si el cliente eligió cambiarse de operador pero ya tiene plan pospago con Claro (D-021). La conversación vuelve al menú: si elige una opción sigue el flujo; si no, despedida.',
    'Veo que ya tienes un plan pospago con Claro 😊 Por eso no puedo ayudarte con un cambio de operador, ya que es solo para líneas de otros operadores. Si necesitas algo de tu plan, elige esta opción:\n🅒 Ya tengo plan: soporte, factura o cambio',
  ),
  // D-023: el cliente ya solicitó una portabilidad y pregunta si quedó.
  t(
    'portabilidad-confirmacion',
    'Sistema',
    '¿Recibiste la confirmación?',
    'PORTABILIDAD_CONFIRMACION',
    'La envía el sistema cuando el cliente pregunta por una portabilidad que ya solicitó (D-023). Su respuesta (sí o no) decide qué sigue.',
    'Claro que sí, te ayudo a revisarlo 😊 ¿Ya recibiste la confirmación de tu solicitud de portabilidad?',
  ),
  t(
    'portabilidad-confirmada',
    'Sistema',
    'Ya recibió la confirmación',
    'PORTABILIDAD_CONFIRMADA',
    'La envía el sistema si el cliente sí recibió la confirmación; después va la plantilla de soporte con los canales de atención.',
    'Entiendo. Por este chat no puedo ayudarte a verificar el estado de tu portabilidad.',
  ),
  t(
    'portabilidad-validar',
    'Sistema',
    'Validar la portabilidad',
    'PORTABILIDAD_VALIDAR',
    'La envía el sistema si el cliente no recibió la confirmación: le pide los datos (los que se eligen en «Flujo → Datos para pasar la venta») para validarla. Lo que se pide va en {datos_faltantes}.',
    'No te preocupes, podemos validarlo 🙌 Para revisar tu solicitud compárteme {datos_faltantes}, por favor.',
  ),
  t(
    'portabilidad-transferencia',
    'Sistema',
    'Transferir la validación',
    'PORTABILIDAD_TRANSFERENCIA',
    'La envía el sistema al pasar la validación de la portabilidad al backoffice, con los datos del cliente.',
    '¡Gracias, {nombre_cliente}! Te transfiero con uno de nuestros asesores para validar tu solicitud de portabilidad. 🚀',
  ),
  t(
    'nota-de-voz-ilegible',
    'Sistema',
    'Nota de voz ilegible',
    'NOTA_DE_VOZ_ILEGIBLE',
    'La envía el sistema cuando el cliente manda una nota de voz que no se puede escuchar o transcribir (con STT_PROVIDER=ninguno, todas): le pide con respeto escribir su solicitud.',
    'Gracias por tu mensaje 🙏 Por este medio no podemos escuchar notas de voz. ¿Me escribes tu solicitud en texto, por favor?',
  ),
];

// ---------- guardado (columna JSON de AgentConfigVersion) ----------

/**
 * Lista de plantillas recibida de afuera (panel o base). null si la forma no es la esperada;
 * el contenido se revisa aparte (reviewTemplates).
 */
export function parseTemplates(raw: unknown): AgentTemplate[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AgentTemplate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const r = item as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
    const [id, group, title, role, when, text] = [
      str('id'),
      str('group'),
      str('title'),
      str('role'),
      str('when') ?? '',
      str('text'),
    ];
    if (id === null || group === null || title === null || role === null || text === null)
      return null;
    if (!(TEMPLATE_ROLES as readonly string[]).includes(role)) return null;
    out.push({
      id: id.trim(),
      group: group.trim(),
      title: title.trim(),
      role: role as TemplateRole,
      when: when.trim(),
      text: text.replace(/\r\n/g, '\n').trim(),
    });
  }
  return out;
}

/**
 * Plantillas de una versión guardada: sin columna (versiones anteriores a D-013) → las de la
 * campaña. D-015: a una versión sin alguna plantilla del sistema se le agregan las de la campaña
 * (el texto que antes estaba en el código), así se ven y se editan en el panel.
 */
export function storedTemplates(raw: unknown): AgentTemplate[] {
  return withSystemTemplates(
    (raw === null || raw === undefined ? null : parseTemplates(raw)) ?? DEFAULT_TEMPLATES,
  );
}

/** D-015: completa las plantillas del sistema que falten con las de la campaña. */
export function withSystemTemplates(templates: readonly AgentTemplate[]): AgentTemplate[] {
  const roles = new Set<string>(templates.map((x) => x.role));
  const ids = new Set(templates.map((x) => x.id));
  const missing = DEFAULT_TEMPLATES.filter(
    (d) => isSystemTemplateRole(d.role) && !roles.has(d.role) && !ids.has(d.id),
  );
  return [...templates, ...missing];
}

/** D-015: plantillas de un rol del sistema (las del agente o, si no tiene, las de la campaña). */
export function systemTemplates(
  templates: readonly AgentTemplate[],
  role: SystemTemplateRole,
): AgentTemplate[] {
  const own = templatesByRole(templates, role);
  return own.length ? own : templatesByRole(DEFAULT_TEMPLATES, role);
}

export function storedReactivation(
  minutes: number | null | undefined,
  max: number | null | undefined,
): ReactivationConfig {
  return {
    minutes: minutes ?? DEFAULT_REACTIVATION.minutes,
    max: max ?? DEFAULT_REACTIVATION.max,
  };
}

// ---------- revisión al guardar ----------

export interface TemplateIssue {
  /** Id de la plantilla (o null si el problema es del conjunto). */
  templateId: string | null;
  message: string;
}

/** Precios, gigas o porcentajes: en una plantilla que envía el robot se verifican contra el catálogo. */
export const TEMPLATE_FIGURE_RE =
  /\$\s*\d|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+(?:[.,]\d+)?\s*(?:gb|gigas?|megas?|mb)\b|\d+(?:[.,]\d+)?\s*%/i;

export function reviewTemplates(
  templates: readonly AgentTemplate[],
  reactivation: ReactivationConfig,
): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const L = TEMPLATE_LIMITS;
  if (templates.length > L.count)
    issues.push({ templateId: null, message: `máximo ${L.count} plantillas` });
  const seen = new Set<string>();
  for (const tp of templates) {
    const id = tp.id;
    const issue = (message: string) => issues.push({ templateId: id || null, message });
    if (!TEMPLATE_ID_RE.test(id) || id.length > L.id)
      issue('id: solo minúsculas, números y guiones (máximo 40)');
    if (seen.has(id)) issue('id repetido');
    seen.add(id);
    if (!(TEMPLATE_ROLES as readonly string[]).includes(tp.role)) issue('rol desconocido');
    if (!tp.title.trim()) issue('título obligatorio');
    if (tp.title.length > L.title) issue(`título: máximo ${L.title} caracteres`);
    if (tp.group.length > L.group) issue(`sección: máximo ${L.group} caracteres`);
    if (tp.when.length > L.when) issue(`«cuándo usarla»: máximo ${L.when} caracteres`);
    if (!tp.text.trim()) issue('texto obligatorio');
    if (tp.text.length > L.text) issue(`texto: máximo ${L.text} caracteres`);
    if (tp.role === 'RESPUESTA' && !tp.when.trim())
      issue('di cuándo usarla: el modelo elige la plantilla con ese texto');
    for (const m of tp.text.matchAll(/\{([^{}]*)\}/g)) {
      if (!(TEMPLATE_VARIABLES as readonly string[]).includes(m[1]!))
        issue(
          `variable desconocida {${m[1]}}: usa {nombre_agente}, {nombre_cliente}, {fecha} o {datos_faltantes}`,
        );
    }
    if (/\{\{|\}\}/.test(tp.text)) issue('el texto no admite marcadores {{…}}');
    // Las de REFERENCIA las escribe el asesor tal cual: solo se revisa lo que envía el robot.
    if (tp.role !== 'REFERENCIA' && /\*\*|__|https?:\/\/|www\./i.test(tp.text))
      issue('formato: *negrita* de WhatsApp con un asterisco, sin enlaces');
    if (tp.role === 'AUTORIZACION' && !tp.text.includes('{fecha}'))
      issue('la autorización debe llevar la fecha del día: escribe {fecha}');
    // D-015: las del sistema las envía el código sin verificar cifras contra el catálogo (regla 11).
    if (isSystemTemplateRole(tp.role) && TEMPLATE_FIGURE_RE.test(tp.text))
      issue('plantilla del sistema: sin precios, gigas ni porcentajes (salen del catálogo)');
  }
  const count = (role: TemplateRole) => templates.filter((x) => x.role === role).length;
  if (count('AUTORIZACION') !== 1)
    issues.push({
      templateId: null,
      message: 'debe haber exactamente una plantilla de AUTORIZACIÓN',
    });
  for (const role of SINGLE_TEMPLATE_ROLES) {
    if (role !== 'AUTORIZACION' && count(role) > 1)
      issues.push({
        templateId: null,
        message: `solo puede haber una plantilla con el rol ${role}`,
      });
  }
  if (
    !Number.isInteger(reactivation.minutes) ||
    reactivation.minutes < L.reactivationMinutesMin ||
    reactivation.minutes > L.reactivationMinutesMax
  )
    issues.push({
      templateId: null,
      message: `reactivación: minutos entre ${L.reactivationMinutesMin} y ${L.reactivationMinutesMax}`,
    });
  if (
    !Number.isInteger(reactivation.max) ||
    reactivation.max < 0 ||
    reactivation.max > L.reactivationMaxMax
  )
    issues.push({
      templateId: null,
      message: `reactivación: entre 0 y ${L.reactivationMaxMax} mensajes`,
    });
  if (reactivation.max > 0 && !count('REACTIVACION'))
    issues.push({
      templateId: null,
      message: 'reactivación activa sin plantillas de REACTIVACIÓN',
    });
  return issues;
}
