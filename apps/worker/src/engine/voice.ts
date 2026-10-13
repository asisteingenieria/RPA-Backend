/**
 * D-010: el texto de una nota de voz entra al motor marcado, para que el modelo sepa que es una
 * transcripción (puede traer errores) y para que el código NO la tome como consentimiento.
 */
export const VOICE_PREFIX = '[nota de voz] ';

export const asVoice = (transcript: string) => `${VOICE_PREFIX}${transcript}`;

export const isVoice = (text: string) => text.startsWith(VOICE_PREFIX);

/** Quita la marca de cada línea (para las reglas deterministas: menú, «no», «asesor»). */
export const stripVoice = (text: string) =>
  text
    .split('\n')
    .map((l) => (l.startsWith(VOICE_PREFIX) ? l.slice(VOICE_PREFIX.length) : l))
    .join('\n');
