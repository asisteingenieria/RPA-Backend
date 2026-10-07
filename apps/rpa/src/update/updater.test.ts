import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@abaya/logger';
import { signRelease, type UpdateStatus } from '@abaya/robot-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstallLayout, RobotUpdater, safeVersion } from './updater.js';

const keys = generateKeyPairSync('ed25519');
const PRIV = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const ZIP = Buffer.from('PK-paquete-sintetico');
const silent = createLogger('t', { level: 'silent' });

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'actualizacion-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manifest(version: string, opts: { priv?: string; sha?: string } = {}) {
  return signRelease(
    {
      product: 'abaya-robot',
      version,
      sha256: opts.sha ?? createHash('sha256').update(ZIP).digest('hex'),
      size: ZIP.length,
      builtAt: new Date().toISOString(),
    },
    opts.priv ?? PRIV,
  );
}

function setup(over: { signed?: unknown; idle?: boolean[] } = {}) {
  const reports: [UpdateStatus, string | undefined, string | undefined][] = [];
  let restarted = 0;
  const idle = [...(over.idle ?? [true])];
  const layout = new InstallLayout(root);
  const updater = new RobotUpdater({
    layout,
    currentVersion: '1.0.0',
    publicKeyPem: PUB,
    fetchManifest: async () => over.signed ?? manifest('1.1.0'),
    download: async (p) => writeFile(p, ZIP),
    report: async (s, v, m) => void reports.push([s, v, m]),
    runIfIdle: async (fn) => {
      if (idle.shift() ?? true) {
        await fn();
        return { ran: true };
      }
      return { ran: false };
    },
    restartForUpdate: () => void restarted++,
    logger: silent,
    extract: async (_zip, dest) => {
      await mkdir(join(dest, 'abaya-robot', 'app', 'dist'), { recursive: true });
      await writeFile(join(dest, 'abaya-robot', 'app', 'dist', 'main.js'), '// nueva');
      await mkdir(join(dest, 'abaya-robot', 'node'), { recursive: true });
    },
    installBrowser: async () => undefined,
  });
  return { updater, layout, reports, restarted: () => restarted };
}

const wait = () => new Promise((r) => setTimeout(r, 30));

describe('actualizador del robot (v1.7)', () => {
  it('versión válida: verifica, prepara en versions\\ y reinicia SOLO al quedar libre', async () => {
    const t = setup();
    await t.updater.request('1.1.0');
    await wait();
    expect(existsSync(join(t.layout.versionDir('1.1.0'), 'app', 'dist', 'main.js'))).toBe(true);
    expect(await t.layout.read('pending.txt')).toBe(safeVersion('1.1.0'));
    expect(t.reports.map((r) => r[0])).toEqual(['DOWNLOADING', 'STAGED']);
    expect(t.restarted()).toBe(1);
    expect(existsSync(join(root, 'descargas'))).toBe(false);
  });

  it('robot ocupado: espera (reporta WAITING_IDLE) y no reinicia todavía', async () => {
    const t = setup({ idle: [false] });
    await t.updater.request('1.1.0');
    await wait();
    expect(t.reports.map((r) => r[0])).toEqual(['DOWNLOADING', 'STAGED', 'WAITING_IDLE']);
    expect(t.restarted()).toBe(0);
    t.updater.stop();
  });

  it('firma de otra clave: no instala nada y reporta FAILED (sin reintentar sola)', async () => {
    const other = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const t = setup({ signed: manifest('1.1.0', { priv: other }) });
    await t.updater.request('1.1.0');
    expect(t.reports.at(-1)).toEqual(['FAILED', '1.1.0', expect.stringMatching(/Firma inválida/)]);
    expect(existsSync(join(root, 'versions'))).toBe(false);
    expect(await t.layout.read('pending.txt')).toBeNull();
    await t.updater.request('1.1.0');
    expect(t.reports).toHaveLength(2); // DOWNLOADING + FAILED, sin segundo intento
  });

  it('paquete alterado (SHA-256 distinto del firmado): no instala', async () => {
    const t = setup({ signed: manifest('1.1.0', { sha: 'b'.repeat(64) }) });
    await t.updater.request('1.1.0');
    expect(t.reports.at(-1)?.[0]).toBe('FAILED');
    expect(t.reports.at(-1)?.[2]).toMatch(/SHA-256/);
    expect(t.restarted()).toBe(0);
  });

  it('la misma versión que ya tiene: no hace nada', async () => {
    const t = setup();
    await t.updater.request('1.0.0');
    await t.updater.request(null);
    expect(t.reports).toEqual([]);
  });

  it('al arrancar: informa la reversión y limpia versiones viejas', async () => {
    const t = setup();
    for (const v of ['0.9.0', '1.0.0', '1.1.0', '0.8.0']) {
      await mkdir(t.layout.versionDir(v), { recursive: true });
    }
    await t.layout.write('current.txt', '1.0.0');
    await t.layout.write('previous.txt', '0.9.0');
    await t.layout.write('rollback.txt', '1.1.0');
    await t.updater.afterStartup();
    expect(t.reports).toEqual([['ROLLED_BACK', '1.1.0', 'la versión nueva no arrancó']]);
    expect(await t.layout.read('rollback.txt')).toBeNull();
    expect(existsSync(t.layout.versionDir('0.8.0'))).toBe(false);
    expect(existsSync(t.layout.versionDir('1.1.0'))).toBe(false);
    expect(existsSync(t.layout.versionDir('0.9.0'))).toBe(true);
    // Una versión que se revirtió no se reintenta sola.
    await t.updater.request('1.1.0');
    expect(t.reports).toHaveLength(1);
  });

  it('versión a prueba: se confirma (APPLIED) y deja de estar a prueba', async () => {
    const t = setup();
    await t.layout.write('probation.txt', '1.0.0');
    await t.updater.confirmIfOnProbation();
    expect(t.reports).toEqual([['APPLIED', '1.0.0', undefined]]);
    expect(await readFile(join(root, 'probation.txt')).catch(() => null)).toBeNull();
  });

  it('botón local: consume la solicitud una sola vez', async () => {
    const t = setup();
    expect(await t.updater.localRequestPending()).toBe(false);
    await writeFile(join(root, 'solicitar-actualizacion.txt'), 'si');
    expect(await t.updater.localRequestPending()).toBe(true);
    expect(await t.updater.localRequestPending()).toBe(false);
  });
});
