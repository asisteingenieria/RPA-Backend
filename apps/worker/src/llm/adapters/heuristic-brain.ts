import type { LlmRequest } from '@abaya/domain';
import type { TurnOutput } from '../../engine/output-schema.js';

/**
 * "LLM simulado" por palabras clave: línea base sin red para CI y para probar el runner.
 * NO mide la calidad de un modelo real; sirve para detectar regresiones del motor, las
 * plantillas y los validadores.
 */
const OUT_OF_SCOPE =
  /\b(factura|cobraron|cobro|reclam\w*|queja|abuso|cancelar|ladron\w*|tarea|partido|matem\w*)\b/i;
const NOT_INTERESTED = /no me interesa|no quiero nada|por ahora no|no, gracias|no gracias/i;
const ACCEPT =
  /el m[aá]s (barato|econ[oó]mico)|lo tomo|quiero ese|me quedo|lo quiero|^dale|^listo|me sirve|ese plan|tomo ese|kiero ese|^ese$/i;
const OBJECTION =
  /caro|alcanza|pensar|consult|permanencia|amarrar|señal|ya tengo|desconfianza|barato|econ[oó]mico/i;
const OPERATORS = /movistar|tigo|wom|claro|virgin|etb|exito|tgo/i;

const base = (over: Partial<TurnOutput>): TurnOutput => ({
  intent: 'PREGUNTA',
  reply: '¡Claro! Cuéntame un poco más para ayudarte.',
  option: null,
  planCode: null,
  extracted: { name: null, currentOperator: null, usage: null },
  confidence: 'MEDIA',
  ...over,
});

export function heuristicBrain(req: LlmRequest): TurnOutput {
  const text = req.messages.at(-1)!.content.trim();
  const lower = text.toLowerCase();
  const stage = /Etapa actual: ([A-Z_]+)/.exec(req.systemDynamic)?.[1] ?? '';
  const codes = [...req.systemDynamic.matchAll(/^- ([A-Z][A-Z0-9]*):/gm)].map((m) => m[1]!);
  const offered = /"offeredPlanCode":"([A-Z0-9]+)"/.exec(req.systemDynamic)?.[1];
  const missing = /Datos que faltan: (.*)/.exec(req.systemDynamic)?.[1] ?? '';

  if (OUT_OF_SCOPE.test(lower))
    return base({ intent: 'FUERA_DE_ALCANCE', reply: 'Te comunico con un asesor.' });

  switch (stage) {
    case 'MENU': {
      const option = /prepago|pospago/.test(lower)
        ? 'B'
        : /portar|traer|cambiarme/.test(lower)
          ? 'A'
          : /factura|soporte|cancelar|cambio de plan/.test(lower)
            ? 'C'
            : null;
      return option
        ? base({ intent: 'ELIGE_OPCION', option, reply: '¡Perfecto! ¿Cuál es tu nombre?' })
        : base({ reply: 'Con gusto te ayudo. Por favor elige una letra del menú.' });
    }
    case 'PERFIL': {
      if (/^\[(audio|imagen)\]$|^(ok|s[ií]|mmm)$/i.test(lower)) {
        return base({ reply: 'No alcancé a entenderte. ¿Me lo puedes escribir?' });
      }
      const ex = {
        name: null as string | null,
        currentOperator: null as string | null,
        usage: null as string | null,
      };
      const name = /(?:me llamo|me yamo|soy|mi nombre es|me dicen)\s+([a-záéíóúñ]+)/i.exec(
        text,
      )?.[1];
      const op = OPERATORS.exec(text)?.[0];
      if (name) ex.name = name;
      if (op) ex.currentOperator = op;
      if (
        /redes|video|llamada|whatsapp|trabaj|stream|juego|netflix|gps|correo|m[uú]sica|datos|rede/i.test(
          lower,
        )
      ) {
        ex.usage = text;
      }
      const needs = missing.split(', ').filter(Boolean);
      if (!name && !op && !ex.usage && needs[0]) {
        if (needs[0] === 'name') ex.name = text.split(/\s+/)[0]!;
        else if (needs[0] === 'currentOperator') ex.currentOperator = text;
        else ex.usage = text;
      }
      const stillMissing = needs.filter((f) => !(ex as Record<string, string | null>)[f]);
      if (!stillMissing.length && codes[0]) {
        return base({
          intent: 'DA_DATO',
          extracted: ex,
          reply: `Te recomiendo este plan:\n{{OFERTA:${codes[0]}}}\n¿Te gustaría tomarlo?`,
        });
      }
      return base({
        intent: 'DA_DATO',
        extracted: ex,
        reply: '¡Gracias! Cuéntame un dato más para recomendarte.',
      });
    }
    case 'OFERTA':
    case 'OBJECIONES': {
      if (NOT_INTERESTED.test(lower)) return base({ intent: 'NO_INTERESADO', reply: 'Entiendo.' });
      if (ACCEPT.test(lower)) {
        const cheapest = /barat|econ[oó]mic/.test(lower) ? codes[0] : undefined;
        const code = cheapest ?? offered ?? codes[0] ?? null;
        return base({ intent: 'ACEPTA_PLAN', planCode: code, reply: '¡Excelente elección! 🎉' });
      }
      if (OBJECTION.test(lower)) {
        return base({
          intent: 'OBJECION',
          reply: `Te entiendo. Mira esta opción:\n{{OFERTA:${codes[0]}}}`,
        });
      }
      return base({
        reply: 'Con gusto te cuento: todo lo que incluye el plan está en la ficha que te compartí.',
      });
    }
    case 'AUTORIZACION':
      return base({ reply: 'La autorización es necesaria para estudiar tu solicitud.' });
    default:
      return base({});
  }
}
