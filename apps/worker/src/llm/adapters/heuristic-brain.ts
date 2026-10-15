import type { LlmRequest } from '@abaya/domain';
import type { TurnOutput } from '../../engine/output-schema.js';

/**
 * "LLM simulado" por palabras clave: línea base sin red para CI y para probar el runner.
 * NO mide la calidad de un modelo real; sirve para detectar regresiones del motor, las
 * plantillas y los validadores.
 */
const OUT_OF_SCOPE =
  /\b(factura|cobraron|cobro|roaming|rooming|saldo|reclam\w*|queja|abuso|cancelar|tarea|partido|matem\w*)\b/i;
/** D-018: insultos y amenazas: se pone un límite y se retoma el paso (no es fuera de alcance). */
const RUDE = /\b(ladron\w*|in[uú]til\w*|est[uú]pid\w*|idiota\w*|bombas?|matar\w*)\b/i;
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
  extracted: { name: null, currentOperator: null, lineType: null, usage: null },
  tipificacion: null,
  confidence: 'MEDIA',
  ...over,
});

/** D-025: tipificación por palabras clave (línea base; el modelo real lee toda la conversación). */
const TIPIFICACION: [RegExp, NonNullable<TurnOutput['tipificacion']>][] = [
  [/cancelar.*(hogar|internet|tv\b|televisi)/, 'SAC_CANCELACION_HOGAR'],
  [/cancelar|cancelaci[oó]n/, 'SAC_CANCELACION_MOVIL'],
  [/factura/, 'SAC_FACTURACION'],
  [/\bpago|recarga(r|s)? (no|saldo)|saldo/, 'SAC_PAGOS_RECARGAS'],
  [/se[ñn]al|sin red|no tengo (internet|datos)|no funciona/, 'SAC_SOPORTE'],
  [/queja|reclamo|petici[oó]n|\bpqr/, 'SAC_PQR'],
  [/\bsim\b.*(lleg|entreg)|(lleg|entreg).*\bsim\b/, 'SAC_DEMORA_SIM'],
  [
    /roaming|fuera del pa[ií]s|consumos?|datos disponibles|minutos (disponibles|que me quedan)/,
    'SAC_DETALLE_MOVIL',
  ],
  [/suspendid|bloquead|reposici[oó]n|reponer (la )?sim|esim/, 'SAC_SOPORTE'],
  [/actualizar (mis )?datos|datos personales/, 'SAC_PQR'],
  [/cambiar (de |mi )?plan|cambio de plan/, 'SAC_CAMBIO_PLAN'],
  [/prefiero (el |seguir en |quedarme en )?(prepago|recargas)/, 'NO_VENTA_PREFIERE_PREPAGO'],
  [
    /(otro operador|tigo|movistar|wom).*(m[aá]s barat|mejor)|(mejor|m[aá]s barat).*(otro operador|tigo|movistar|wom)/,
    'NO_VENTA_MEJOR_OFERTA',
  ],
  [
    /internet (del |para la )?(casa|hogar)|servicios? (del )?hogar|t ?& ?t|\btyt\b/,
    'NO_VENTA_HOGAR_TYT',
  ],
];

export function heuristicBrain(req: LlmRequest): TurnOutput {
  const out = turn(req);
  const lower = req.messages.at(-1)!.content.toLowerCase();
  const tag = TIPIFICACION.find(([re]) => re.test(lower))?.[1] ?? null;
  return tag ? { ...out, tipificacion: tag } : out;
}

function turn(req: LlmRequest): TurnOutput {
  const text = req.messages.at(-1)!.content.trim();
  const lower = text.toLowerCase();
  const stage = /Etapa actual: ([A-Z_]+)/.exec(req.systemDynamic)?.[1] ?? '';
  const codes = [...req.systemDynamic.matchAll(/^- ([A-Z][A-Z0-9]*):/gm)].map((m) => m[1]!);
  const offered = /"offeredPlanCode":"([A-Z0-9]+)"/.exec(req.systemDynamic)?.[1];
  const missing = /Datos que faltan: (.*)/.exec(req.systemDynamic)?.[1] ?? '';

  if (RUDE.test(lower))
    return base({
      intent: 'PREGUNTA',
      reply: 'Así no puedo ayudarte, pero con gusto te ayudo con tu plan. ¿Seguimos?',
    });
  if (OUT_OF_SCOPE.test(lower))
    return base({ intent: 'FUERA_DE_ALCANCE', reply: 'Te comunico con un asesor.' });

  switch (stage) {
    case 'MENU': {
      // D-023: pregunta por una portabilidad que ya solicitó.
      if (
        /(solicit|ped|hic|tramit)[a-záéíóúñ]*\s+(una\s+|la\s+)?portabilidad|mi\s+portabilidad/.test(
          lower,
        )
      )
        return base({ intent: 'CONSULTA_PORTABILIDAD', reply: 'Entiendo.' });
      const option = /n[uú]mero nuevo|l[ií]nea nueva|otra l[ií]nea/.test(lower)
        ? 'E'
        : /prepago|pospago/.test(lower)
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
      const needs = missing.split(', ').filter(Boolean);
      // D-021: tipo de línea con el operador propio, también como «sí»/«no» a «¿ya eres pospago?».
      const lineType: 'PREPAGO' | 'POSPAGO' | null = /prepago|recarga/.test(lower)
        ? 'PREPAGO'
        : /pos(t)?pago|ya tengo plan/.test(lower)
          ? 'POSPAGO'
          : needs[0] === 'lineType' && /^no\b/.test(lower)
            ? 'PREPAGO'
            : needs[0] === 'lineType' && /^s[ií]\b/.test(lower)
              ? 'POSPAGO'
              : null;
      if (/^\[(audio|imagen)\]$|^(ok|s[ií]|mmm)$/i.test(lower) && !lineType) {
        return base({ reply: 'No alcancé a entenderte. ¿Me lo puedes escribir?' });
      }
      const ex = {
        name: null as string | null,
        currentOperator: null as string | null,
        lineType,
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
      if (!name && !op && !ex.usage && !lineType && needs[0]) {
        if (needs[0] === 'name') ex.name = text.split(/\s+/)[0]!;
        else if (needs[0] === 'currentOperator') ex.currentOperator = text;
        else ex.usage = text;
      }
      const stillMissing = needs.filter((f) => !(ex as Record<string, string | null>)[f]);
      if (stillMissing[0] === 'lineType') {
        return base({
          intent: 'DA_DATO',
          extracted: ex,
          reply: '{{PLANTILLA:ya-pospago}}',
        });
      }
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
