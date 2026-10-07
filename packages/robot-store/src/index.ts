/**
 * Persistencia de las operaciones del robot (v1.6, sección 2.8): la usan la pasarela del
 * servidor (robots hijos) y el robot en modo directo (desarrollo, pruebas y demo).
 */
export * from './action-log.js';
export * from './gateway-protocol.js';
export * from './handoff.repository.js';
export * from './inbound-queue.js';
export * from './inbound-sink.js';
export * from './inbound.repository.js';
export * from './outbound.repository.js';
export * from './presence.store.js';
export * from './recovery.repository.js';
export * from './robot-queues.js';
export * from './session.repository.js';
export * from './sweep.repository.js';
export * from './release.js';
