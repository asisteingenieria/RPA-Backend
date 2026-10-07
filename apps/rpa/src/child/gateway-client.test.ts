import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@abaya/logger';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RobotRefusedError } from '../lifecycle.js';
import { AgentFile } from './agent-file.js';
import { GatewayClient, assertSecureServer } from './gateway-client.js';
import { DpapiProtector, PlainProtector } from './protector.js';

const silent = createLogger('t', { level: 'silent' });
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hijo-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Servidor falso: rota tokens como el real y registra las llamadas. */
function fakeServer(opts: { ttlMs?: number; refuse?: boolean } = {}) {
  let refresh = 'r'.repeat(43);
  let n = 0;
  const calls: { url: string; auth?: string; body?: unknown }[] = [];
  let accessValid = new Set<string>();
  const impl = (async (url: URL | string, init: RequestInit = {}) => {
    const u = String(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, auth: headers.authorization, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    if (u.endsWith('/token')) {
      if (opts.refuse) return json(401, { message: 'Instalación revocada' });
      if ((body as { refreshToken: string }).refreshToken !== refresh) {
        return json(401, { message: 'no válido' });
      }
      refresh = `r-${++n}`.padEnd(43, 'x');
      const access = `acceso-${n}`;
      accessValid = new Set([access]);
      return json(200, {
        robotUser: 'robot-01',
        accessToken: access,
        expiresAt: new Date(Date.now() + (opts.ttlMs ?? 3_600_000)).toISOString(),
        refreshToken: refresh,
      });
    }
    const token = headers.authorization?.slice(7) ?? '';
    if (!accessValid.has(token)) return json(401, { message: 'vencido' });
    return json(200, { result: { ok: true } });
  }) as typeof fetch;
  return {
    impl,
    calls,
    expireAccess: () => (accessValid = new Set()),
    currentRefresh: () => refresh,
  };
}

async function agentWith(token: string) {
  return AgentFile.create(join(dir, 'robot.json'), new PlainProtector(), {
    server: 'http://127.0.0.1:3000',
    robotUser: 'robot-01',
    refreshToken: token,
  });
}

describe('archivo del equipo (robot.json v2)', () => {
  it('migra el formato anterior y guarda el token rotado protegido', async () => {
    const path = join(dir, 'robot.json');
    const legacy = 't'.repeat(43);
    await writeFile(
      path,
      JSON.stringify({ server: 'https://padre', robotUser: 'robot-01', token: legacy }),
    );
    const f = await AgentFile.open(path, new PlainProtector());
    expect(await f.refreshToken()).toBe(legacy);
    expect((await f.localKey()).length).toBe(32);
    await f.setRefreshToken('nuevo-token');
    const reopened = await AgentFile.open(path, new PlainProtector());
    expect(await reopened.refreshToken()).toBe('nuevo-token');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 2,
      protection: 'none',
    });
  });

  it.runIf(process.platform === 'win32')(
    'con DPAPI el archivo no contiene el token ni la clave en claro',
    async () => {
      const path = join(dir, 'robot.json');
      const token = 'token-de-renovacion-'.padEnd(43, 'z');
      await AgentFile.create(path, new DpapiProtector(), {
        server: 'https://padre',
        robotUser: 'robot-01',
        refreshToken: token,
      });
      const raw = await readFile(path, 'utf8');
      expect(raw).not.toContain('token-de-renovacion');
      expect(JSON.parse(raw)).toMatchObject({ protection: 'dpapi' });
      expect(await (await AgentFile.open(path)).refreshToken()).toBe(token);
    },
    60_000,
  );
});

describe('cliente de la pasarela', () => {
  it('exige HTTPS salvo en el propio equipo o con permiso explícito', () => {
    expect(() => assertSecureServer('http://servidor.interno')).toThrow(/HTTPS/);
    expect(assertSecureServer('https://servidor.interno').hostname).toBe('servidor.interno');
    expect(assertSecureServer('http://127.0.0.1:3000').port).toBe('3000');
  });

  it('al arrancar renueva y guarda el token rotado ANTES de usar el acceso', async () => {
    const s = fakeServer();
    const agent = await agentWith(s.currentRefresh());
    const c = new GatewayClient(agent, silent, s.impl);
    await c.start();
    expect(await agent.refreshToken()).toBe(s.currentRefresh());
    await c.rpc('session.get', {});
    expect(s.calls.at(-1)!.auth).toBe('Bearer acceso-1');
  });

  it('acceso vencido en el servidor: renueva una vez y la operación no se pierde', async () => {
    const s = fakeServer();
    const c = new GatewayClient(await agentWith(s.currentRefresh()), silent, s.impl);
    await c.start();
    s.expireAccess();
    expect(await c.rpc('session.get', {})).toEqual({ ok: true });
    expect(s.calls.filter((x) => x.url.endsWith('/token'))).toHaveLength(2);
    expect(s.calls.at(-1)!.auth).toBe('Bearer acceso-2');
  });

  it('acceso por vencer: renueva antes de la operación (sin cortar nada)', async () => {
    const s = fakeServer({ ttlMs: 3_000 }); // vence en 3 s (< 5 s de margen)
    const c = new GatewayClient(await agentWith(s.currentRefresh()), silent, s.impl);
    await c.start();
    await c.rpc('session.get', {});
    expect(s.calls.filter((x) => x.url.endsWith('/token')).length).toBeGreaterThanOrEqual(2);
    await c.close();
  });

  it('instalación revocada al arrancar: RobotRefusedError (el lanzador no reintenta)', async () => {
    const s = fakeServer({ refuse: true });
    const c = new GatewayClient(await agentWith('x'.repeat(43)), silent, s.impl);
    await expect(c.start()).rejects.toBeInstanceOf(RobotRefusedError);
  });

  it('sin conexión a la pasarela el robot no actúa (falla cerrado)', async () => {
    const s = fakeServer();
    const c = new GatewayClient(await agentWith(s.currentRefresh()), silent, s.impl);
    await c.start();
    expect(c.acting).toBe(false);
  });
});
