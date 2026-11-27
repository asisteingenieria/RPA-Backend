import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  loadSecretsIntoEnv,
  secretIdFor,
  secretNames,
  signServiceAccountJwt,
  type SecretsLog,
} from './secrets.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'abaya-secretos@claro-whatsapp.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'k1',
};
const SECRET_VALUE = 'valor-super-secreto-123';

function memoryLog() {
  const lines: string[] = [];
  const log: SecretsLog = {
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
  };
  return { log, lines };
}

const baseEnv = (): NodeJS.ProcessEnv => ({
  SECRETS_PROVIDER: 'gcp',
  SECRETS_GCP_PROJECT: 'claro-whatsapp',
  GOOGLE_APPLICATION_CREDENTIALS: '/ruta/sa.json',
  SECRETS_NAMES: 'GEMINI_API_KEY,DATABASE_URL',
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Bóveda falsa: `vault` = id del secreto → valor. */
function fakeGoogle(
  vault: Record<string, string>,
  opts: { failFirst?: number; status?: number } = {},
) {
  let failures = opts.failFirst ?? 0;
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      if (failures > 0) {
        failures--;
        throw new TypeError('fetch failed');
      }
      expect(String(init?.body)).toContain(
        'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
      );
      return json(200, { access_token: 'tok', expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    if (opts.status) return json(opts.status, { error: {} });
    const id = /secrets\/([^/]+)\/versions\/latest:access$/.exec(url)?.[1] ?? '';
    if (!(id in vault)) return json(404, { error: { code: 404 } });
    return json(200, { payload: { data: Buffer.from(vault[id]!).toString('base64') } });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const readSa = async () => JSON.stringify(sa);
const noSleep = async (_ms: number) => {};

describe('nombres de los secretos', () => {
  it('convierte la variable al id de la bóveda', () => {
    expect(secretIdFor('GEMINI_API_KEY')).toBe('abaya-gemini-api-key');
    expect(secretIdFor('DATABASE_URL', 'x-')).toBe('x-database-url');
  });

  it('usa la lista por defecto y descarta nombres inválidos', () => {
    expect(secretNames({})).toContain('FIELD_ENCRYPTION_KEY');
    expect(secretNames({ SECRETS_NAMES: ' A_B , a-b ,A_B,../X' })).toEqual(['A_B']);
  });
});

describe('JWT de la cuenta de servicio', () => {
  it('va firmado con RS256 y con los datos de Google', () => {
    const jwt = signServiceAccountJwt(sa, 1_000);
    const [h, c, s] = jwt.split('.');
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'k1',
    });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({
      iss: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000,
      exp: 4_600,
    });
  });
});

describe('loadSecretsIntoEnv', () => {
  it('con SECRETS_PROVIDER vacío no hace nada', async () => {
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'del-env' };
    const f = vi.fn();
    const r = await loadSecretsIntoEnv({ env, fetch: f as unknown as typeof fetch });
    expect(r.provider).toBe('env');
    expect(f).not.toHaveBeenCalled();
    expect(env.GEMINI_API_KEY).toBe('del-env');
  });

  it('carga los secretos de la bóveda por encima del .env', async () => {
    const env = { ...baseEnv(), GEMINI_API_KEY: 'viejo', DATABASE_URL: 'postgresql://env' };
    const g = fakeGoogle({ 'abaya-gemini-api-key': `${SECRET_VALUE}\n` });
    const { log, lines } = memoryLog();
    const r = await loadSecretsIntoEnv({ env, fetch: g.fetch, log, readFile: readSa });
    expect(r).toMatchObject({
      loaded: ['GEMINI_API_KEY'],
      missing: ['DATABASE_URL'],
      fellBack: false,
    });
    expect(env.GEMINI_API_KEY).toBe(SECRET_VALUE); // sin el salto de línea final
    expect(env.DATABASE_URL).toBe('postgresql://env');
    expect(g.calls).toContain(
      'https://secretmanager.googleapis.com/v1/projects/claro-whatsapp/secrets/abaya-gemini-api-key/versions/latest:access',
    );
    expect(lines.join('\n')).toContain('fuera de la bóveda, se usa el .env: DATABASE_URL');
    expect(lines.join('\n')).not.toContain(SECRET_VALUE);
  });

  it('reintenta mientras no hay red', async () => {
    const env = baseEnv();
    const g = fakeGoogle({ 'abaya-gemini-api-key': SECRET_VALUE }, { failFirst: 3 });
    const sleep = vi.fn(noSleep);
    const r = await loadSecretsIntoEnv({
      env,
      fetch: g.fetch,
      log: memoryLog().log,
      readFile: readSa,
      sleep,
    });
    expect(r.loaded).toEqual(['GEMINI_API_KEY']);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2_000, 4_000, 8_000]);
  });

  it('sin permiso sigue con el .env y no reintenta', async () => {
    const env = { ...baseEnv(), GEMINI_API_KEY: 'del-env' };
    const g = fakeGoogle({}, { status: 403 });
    const sleep = vi.fn(noSleep);
    const { log, lines } = memoryLog();
    const r = await loadSecretsIntoEnv({ env, fetch: g.fetch, log, readFile: readSa, sleep });
    expect(r.fellBack).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(env.GEMINI_API_KEY).toBe('del-env');
    expect(lines.join('\n')).toMatch(/HTTP 403.*secretAccessor/);
  });

  it('con el JSON de la cuenta inválido sigue con el .env', async () => {
    const r = await loadSecretsIntoEnv({
      env: baseEnv(),
      fetch: vi.fn() as unknown as typeof fetch,
      log: memoryLog().log,
      readFile: async () => 'no es json',
    });
    expect(r.fellBack).toBe(true);
  });

  it('con el proyecto vacío o un proveedor desconocido sigue con el .env', async () => {
    const quiet = memoryLog().log;
    expect(
      (await loadSecretsIntoEnv({ env: { ...baseEnv(), SECRETS_GCP_PROJECT: '' }, log: quiet }))
        .fellBack,
    ).toBe(true);
    expect(
      (await loadSecretsIntoEnv({ env: { SECRETS_PROVIDER: 'vault' }, log: quiet })).fellBack,
    ).toBe(true);
  });

  it('con tope de intentos se rinde y sigue con el .env (consola)', async () => {
    const g = fakeGoogle({}, { failFirst: 99 });
    const r = await loadSecretsIntoEnv({
      env: baseEnv(),
      fetch: g.fetch,
      log: memoryLog().log,
      readFile: readSa,
      sleep: noSleep,
      maxAttempts: 2,
    });
    expect(r.fellBack).toBe(true);
  });
});
