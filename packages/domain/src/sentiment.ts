/**
 * D-035: sentimiento del cliente, solo para medición (reglas de Claro). El modelo lo clasifica en
 * cada turno (campo `sentimiento`, lista cerrada); el código guarda el último y el peor de la
 * conversación. No cambia lo que el robot hace ni dice.
 */
export const SENTIMENTS = ['POSITIVO', 'NEUTRO', 'NEGATIVO', 'MOLESTO'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  POSITIVO: 'Positivo',
  NEUTRO: 'Neutro',
  NEGATIVO: 'Negativo',
  MOLESTO: 'Molesto',
};

export const isSentiment = (v: unknown): v is Sentiment =>
  typeof v === 'string' && (SENTIMENTS as readonly string[]).includes(v);

/** El más negativo de los dos (orden de SENTIMENTS). */
export function worseSentiment(a: Sentiment | undefined, b: Sentiment): Sentiment {
  if (!a) return b;
  return SENTIMENTS.indexOf(b) > SENTIMENTS.indexOf(a) ? b : a;
}
