/**
 * D-050: bóveda propia de secretos (Google Secret Manager).
 *
 * Se llama al arrancar la API y el worker, ANTES de `loadConfig()`: copia los secretos de la
 * bóveda a `process.env`. Sin SDK: JWT RS256 de la cuenta de servicio → token OAuth → API REST.
 *
 * Reglas:
 * - Nunca se escribe un valor en el log: solo nombres de variables y códigos HTTP.
 * - Disponibilidad (el robot no puede caerse en horario): `SECRETS_PROVIDER=env` (por defecto) no
 *   hace nada; si falta un secreto en la bóveda se usa el `.env`; sin permiso o con el JSON de la
 *   cuenta inválido se sigue con el `.env`; sin red o con 5xx/429 se reintenta sin límite.
 */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Variables que se buscan en la bóveda si `SECRETS_NAMES` está vacío. */
export const DEFAULT_SECRET_NAMES = [
  'DATABASE_URL',
  'REDIS_URL',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_PREVIOUS_KEYS',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'VOYAGE_API_KEY',
  'ALERT_WEBHOOK_URL',
] as const;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://secretmanager.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface SecretsLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LoadSecretsOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: SecretsLog;
  /** Espera entre reintentos (pruebas). */
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  /** Tope de intentos por fallas transitorias; por defecto sin límite. */
  maxAttempts?: number;
}

export interface LoadSecretsResult {
  provider: 'env' | 'gcp';
  /** Variables que vinieron de la bóveda. */
  loaded: string[];
  /** Variables que no están en la bóveda (siguen con el `.env`). */
  missing: string[];
  /** Hubo un error de configuración o permisos y se siguió con el `.env`. */
  fellBack: boolean;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

/** Falla que no se arregla reintentando (permisos, configuración). */
class PermanentError extends Error {}

const stderrLog: SecretsLog = {
  info: (m) => void process.stderr.write(`[secretos] ${m}\n`),
  warn: (m) => void process.stderr.write(`[secretos] AVISO ${m}\n`),
  error: (m) => void process.stderr.write(`[secretos] ERROR ${m}\n`),
};

/** `GEMINI_API_KEY` → `abaya-gemini-api-key`. */
export function secretIdFor(envName: string, prefix = 'abaya-'): string {
  return `${prefix}${envName.toLowerCase().replace(/_/g, '-')}`;
}

export function secretNames(env: NodeJS.ProcessEnv): string[] {
  const raw = env.SECRETS_NAMES?.trim();
  const list = raw ? raw.split(',') : [...DEFAULT_SECRET_NAMES];
  return [...new Set(list.map((n) => n.trim()).filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n)))];
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export function signServiceAccountJwt(sa: ServiceAccount, nowSec: number): string {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    ...(sa.private_key_id ? { kid: sa.private_key_id } : {}),
  };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri ?? TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  return `${unsigned}.${b64url(signature)}`;
}

function parseServiceAccount(text: string): ServiceAccount {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PermanentError('el archivo de la cuenta de servicio no es JSON');
  }
  const sa = data as Partial<ServiceAccount>;
  if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') {
    throw new PermanentError(
      'el archivo de la cuenta de servicio no tiene client_email/private_key',
    );
  }
  return sa as ServiceAccount;
}

const isTransient = (status: number) => status === 429 || status >= 500;

/**
 * Copia los secretos de la bóveda a `env`. Nunca lanza por permisos ni configuración (sigue con
 * el `.env`); con fallas de red reintenta hasta `maxAttempts` (por defecto, sin límite).
 */
export async function loadSecretsIntoEnv(
  opts: LoadSecretsOptions = {},
): Promise<LoadSecretsResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? stderrLog;
  const provider = (env.SECRETS_PROVIDER ?? '').trim().toLowerCase() || 'env';
  if (provider === 'env') return { provider: 'env', loaded: [], missing: [], fellBack: false };
  if (provider !== 'gcp') {
    log.error(`SECRETS_PROVIDER «${provider}» no es válido (env | gcp); se usa el .env`);
    return { provider: 'env', loaded: [], missing: [], fellBack: true };
  }

  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const read = opts.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const maxAttempts = opts.maxAttempts ?? Infinity;
  const project = env.SECRETS_GCP_PROJECT?.trim();
  const credPath = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const prefix = env.SECRETS_PREFIX?.trim() || 'abaya-';
  const names = secretNames(env);
  const fallback = (msg: string): LoadSecretsResult => {
    log.error(`${msg}; se sigue con el .env`);
    return { provider: 'gcp', loaded: [], missing: [], fellBack: true };
  };

  if (!project || !/^[a-z][a-z0-9-]{4,29}$/.test(project)) {
    return fallback('SECRETS_GCP_PROJECT vacío o inválido');
  }
  if (!credPath) return fallback('GOOGLE_APPLICATION_CREDENTIALS vacío');

  let sa: ServiceAccount;
  try {
    sa = parseServiceAccount(await read(credPath));
  } catch (e) {
    return fallback(
      e instanceof PermanentError
        ? e.message
        : 'no se pudo leer el archivo de la cuenta de servicio',
    );
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const values = await fetchAll(doFetch, sa, project, prefix, names);
      const loaded: string[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const v = values.get(name);
        if (v === undefined) missing.push(name);
        else {
          env[name] = v;
          loaded.push(name);
        }
      }
      log.info(`bóveda: ${loaded.length} secretos cargados (${loaded.join(', ') || 'ninguno'})`);
      // Los que no están en la bóveda son normales (p. ej. un proveedor que no se usa).
      const fromEnv = missing.filter((n) => env[n]);
      if (fromEnv.length) log.warn(`fuera de la bóveda, se usa el .env: ${fromEnv.join(', ')}`);
      return { provider: 'gcp', loaded, missing, fellBack: false };
    } catch (e) {
      if (e instanceof PermanentError) return fallback(e.message);
      const wait = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
      const why = e instanceof Error ? e.message : 'error desconocido';
      if (attempt >= maxAttempts)
        return fallback(`bóveda inalcanzable tras ${attempt} intentos (${why})`);
      log.warn(`bóveda inalcanzable (${why}); reintento ${attempt} en ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

async function fetchAll(
  doFetch: typeof fetch,
  sa: ServiceAccount,
  project: string,
  prefix: string,
  names: string[],
): Promise<Map<string, string>> {
  const token = await accessToken(doFetch, sa);
  const out = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      const id = secretIdFor(name, prefix);
      const res = await doFetch(
        `${API_URL}/projects/${project}/secrets/${id}/versions/latest:access`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
      );
      if (res.status === 404) return; // no existe (o sin versión habilitada): se usa el .env
      if (isTransient(res.status)) throw new Error(`HTTP ${res.status} en ${id}`);
      if (!res.ok)
        throw new PermanentError(`HTTP ${res.status} al leer ${id} (¿permiso secretAccessor?)`);
      const body = (await res.json()) as { payload?: { data?: string } };
      const data = body.payload?.data;
      if (typeof data !== 'string') throw new PermanentError(`respuesta sin contenido en ${id}`);
      // Un salto de línea al final (p. ej. `echo` al crear el secreto) no es parte del valor.
      out.set(
        name,
        Buffer.from(data, 'base64')
          .toString('utf8')
          .replace(/\r?\n$/, ''),
      );
    }),
  );
  return out;
}

async function accessToken(doFetch: typeof fetch, sa: ServiceAccount): Promise<string> {
  let assertion: string;
  try {
    assertion = signServiceAccountJwt(sa, Math.floor(Date.now() / 1000));
  } catch {
    throw new PermanentError('la llave privada de la cuenta de servicio no es válida');
  }
  const res = await doFetch(sa.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (isTransient(res.status)) throw new Error(`HTTP ${res.status} al pedir el token`);
  if (!res.ok)
    throw new PermanentError(
      `HTTP ${res.status} al pedir el token (¿cuenta deshabilitada o llave revocada?)`,
    );
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new PermanentError('respuesta de token sin access_token');
  return body.access_token;
}
