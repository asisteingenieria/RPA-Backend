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
 * Enmascara correos, teléfonos y números de documento dentro de textos libres. El correo va
 * primero para que sus dígitos no queden a medias como [NUM].
 */
export function scrubText(input: string): string {
  return input.replace(EMAIL_RE, '[CORREO]').replace(PHONE_RE, '[TEL]').replace(DOC_RE, '[NUM]');
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
