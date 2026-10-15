/**
 * D-025: tipificación al cerrar en ySocial un chat que NO se transfiere («Finalizar y cerrar el
 * caso» pide una etiqueta). Lista cerrada: el modelo elige el motivo según la conversación
 * (campo `tipificacion` del turno) y el código lo lleva al cierre; el texto exacto de cada
 * etiqueta en ySocial vive en `apps/rpa/src/abaya/selectors.ts` (regla 3).
 */
export const CLOSE_TAGS = [
  'NO_VENTA_HOGAR_TYT',
  'NO_VENTA_PREFIERE_PREPAGO',
  'NO_VENTA_MEJOR_OFERTA',
  'NO_VENTA_ABANDONA',
  'SAC_CAMBIO_PLAN',
  'SAC_CANCELACION_HOGAR',
  'SAC_CANCELACION_MOVIL',
  'SAC_PQR',
  'SAC_DEMORA_SIM',
  'SAC_DETALLE_HOGAR',
  'SAC_DETALLE_MOVIL',
  'SAC_FACTURACION',
  'SAC_PAGOS_RECARGAS',
  'SAC_SOPORTE',
] as const;
export type CloseTag = (typeof CLOSE_TAGS)[number];

/**
 * Las que puede elegir el modelo. «Cliente abandona conversación» no: la pone el código cuando el
 * cliente deja de responder (reactivaciones agotadas, D-013).
 */
export const MODEL_CLOSE_TAGS = [
  'NO_VENTA_HOGAR_TYT',
  'NO_VENTA_PREFIERE_PREPAGO',
  'NO_VENTA_MEJOR_OFERTA',
  'SAC_CAMBIO_PLAN',
  'SAC_CANCELACION_HOGAR',
  'SAC_CANCELACION_MOVIL',
  'SAC_PQR',
  'SAC_DEMORA_SIM',
  'SAC_DETALLE_HOGAR',
  'SAC_DETALLE_MOVIL',
  'SAC_FACTURACION',
  'SAC_PAGOS_RECARGAS',
  'SAC_SOPORTE',
] as const satisfies readonly CloseTag[];
export type ModelCloseTag = (typeof MODEL_CLOSE_TAGS)[number];

export interface CloseTagInfo {
  group: 'NO_VENTA' | 'SAC';
  /** Cómo se muestra en el panel (Trazabilidad, «Probar agente»). */
  name: string;
  /**
   * Cuándo corresponde (lo lee el modelo; 15/10/2026, del usuario). Incluye los casos del menú de
   * servicio de la opción C de la campaña (soporte, facturación, cambio de plan, pagos, consumos,
   * roaming, SIM, suspensión, datos personales, PQR, retención): solo para tipificar, el flujo de
   * la conversación no cambia.
   */
  when: string;
}

export const CLOSE_TAG_INFO: Record<CloseTag, CloseTagInfo> = {
  NO_VENTA_HOGAR_TYT: {
    group: 'NO_VENTA',
    name: 'No venta · Cliente interesado hogar - T&T',
    when: 'el cliente quiere adquirir servicios hogar o T&T (internet, TV o telefonía fija)',
  },
  NO_VENTA_PREFIERE_PREPAGO: {
    group: 'NO_VENTA',
    name: 'No venta · Cliente prefiere Prepago',
    when: 'el cliente prefiere mantenerse en prepago (recargas)',
  },
  NO_VENTA_MEJOR_OFERTA: {
    group: 'NO_VENTA',
    name: 'No venta · Mejor oferta otros operadores',
    when: 'el cliente dice que hay mejores ofertas en otros operadores',
  },
  NO_VENTA_ABANDONA: {
    group: 'NO_VENTA',
    name: 'No venta · Cliente abandona conversación',
    when: 'el cliente deja de responder (la pone el sistema)',
  },
  SAC_CAMBIO_PLAN: {
    group: 'SAC',
    name: 'SAC · Cambio de plan',
    when: 'el cliente ya tiene un servicio pospago y quiere cambiar de plan o las condiciones de su plan actual, o conocer otros planes para su línea pospago',
  },
  SAC_CANCELACION_HOGAR: {
    group: 'SAC',
    name: 'SAC · Cancelación hogar',
    when: 'el cliente quiere cancelar un plan hogar',
  },
  SAC_CANCELACION_MOVIL: {
    group: 'SAC',
    name: 'SAC · Cancelación móvil',
    when: 'el cliente quiere cancelar su plan móvil, terminar el servicio o conocer alternativas antes de cancelar (retención; la opción D del menú)',
  },
  SAC_PQR: {
    group: 'SAC',
    name: 'SAC · Consulta - Radicación PQR',
    when: 'el cliente manifiesta una petición, queja o reclamo sobre su servicio, o quiere actualizar o validar sus datos personales registrados',
  },
  SAC_DEMORA_SIM: {
    group: 'SAC',
    name: 'SAC · Demora entrega SIM CARD',
    when: 'el cliente dice que no le han entregado su SIM (si necesita reponerla o activarla, es SAC_SOPORTE)',
  },
  SAC_DETALLE_HOGAR: {
    group: 'SAC',
    name: 'SAC · Detalle plan hogar',
    when: 'el cliente pregunta detalles sobre planes hogar',
  },
  SAC_DETALLE_MOVIL: {
    group: 'SAC',
    name: 'SAC · Detalle plan móvil',
    when: 'el cliente pregunta detalles de su plan móvil: sus consumos (datos disponibles, minutos), beneficios o servicios activos, o roaming internacional (uso de su línea fuera de Colombia)',
  },
  SAC_FACTURACION: {
    group: 'SAC',
    name: 'SAC · Facturación',
    when: 'el cliente quiere consultar su factura, validar cobros o aclarar el valor a pagar',
  },
  SAC_PAGOS_RECARGAS: {
    group: 'SAC',
    name: 'SAC · Pagos y recargas',
    when: 'el cliente quiere confirmar un pago, validar el estado de su cuenta o pregunta por recargas',
  },
  SAC_SOPORTE: {
    group: 'SAC',
    name: 'SAC · Soporte',
    when: 'el cliente tiene fallas con sus datos móviles, llamadas, señal o conexión a internet; necesita reponer o activar su SIM o eSIM; o su línea está suspendida o bloqueada',
  },
};

export function isCloseTag(v: unknown): v is CloseTag {
  return typeof v === 'string' && (CLOSE_TAGS as readonly string[]).includes(v);
}

/** Lista para la regla del sistema (qué poner en "tipificacion"). */
export function closeTagsForModel(): string {
  return MODEL_CLOSE_TAGS.map((t) => `${t} = ${CLOSE_TAG_INFO[t].when}`).join('; ');
}
