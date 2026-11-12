import { pino, type Logger, type LoggerOptions } from 'pino';

const SENSITIVE_KEYS = [
  'password',
  'token',
  'apiKey',
  'authorization',
  'cookie',
  'body',
  'text',
  'content',
  'phone',
  'name',
  'document',
  'summary',
  'customerReply',
];

/** Campos que nunca deben salir en claro en los logs (regla 6). */
export const REDACT_PATHS = [
  // `name` en la raíz es el nombre del logger de pino, no un dato personal.
  ...SENSITIVE_KEYS.filter((k) => k !== 'name'),
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
];

const PHONE_RE = /(\+?57\s?)?\b3\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g;
const DOC_RE = /\b\d{6,10}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/**
 * D-046: el nombre que da el cliente («me llamo…», «mi nombre (completo) es…», «nombre: …»): hasta
 * cuatro palabras después. Puede tapar de más; en un log eso es preferible a dejar un nombre.
 */
const NAME_RE =
  /\b(me llamo|mi nombre(?: completo)? es|nombre(?: completo)?\s*:)\s*[\p{L}'-]+(?:\s+[\p{L}'-]+){0,3}/giu;

/**
 * Enmascara correos, teléfonos, números de documento y nombres dados por el cliente dentro de
 * textos libres. El correo va primero para que sus dígitos no queden a medias como [NUM].
 */
export function scrubText(input: string): string {
  return input
    .replace(EMAIL_RE, '[CORREO]')
    .replace(PHONE_RE, '[TEL]')
    .replace(DOC_RE, '[NUM]')
    .replace(NAME_RE, '$1 [NOMBRE]');
}

export function createLogger(
  name: string,
  options: LoggerOptions = {},
  destination?: pino.DestinationStream,
): Logger {
  const opts: LoggerOptions = {
    name,
    level: process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      // D-046: `name` del objeto de la llamada (p. ej. el nombre de un cliente) no sale en claro;
      // el nombre del logger va aparte (bindings) y no se toca.
      log(obj) {
        if (!('name' in obj)) return obj;
        const { name: _omitted, ...rest } = obj;
        return { ...rest, nameRedacted: '[REDACTED]' };
      },
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a: unknown) => (typeof a === 'string' ? scrubText(a) : a));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    ...options,
  };
  return destination ? pino(opts, destination) : pino(opts);
}

export type { Logger };
