import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { protectorFor, type Protector } from './protector.js';

/**
 * `robot.json` (v1.6): la URL del servidor, el usuario robot y, protegidos con DPAPI, el token
 * de renovación (cambia en cada renovación) y la clave local del equipo (sesión guardada de
 * Abaya y trazas pendientes de subir). Nada de credenciales de Abaya ni del servidor.
 */
const v2Schema = z.object({
  version: z.literal(2),
  server: z.string().url(),
  robotUser: z.string().min(1),
  protection: z.enum(['dpapi', 'none']),
  refreshToken: z.string().min(16),
  localKey: z.string().min(16),
});
/** Formato v1.4 (token en claro): se migra al abrirlo. */
const v1Schema = z.object({
  server: z.string().url(),
  robotUser: z.string().min(1),
  token: z.string().min(32),
});

export class AgentFile {
  private constructor(
    private readonly path: string,
    private readonly protector: Protector,
    readonly server: string,
    readonly robotUser: string,
    private sealedRefresh: string,
    private readonly sealedLocalKey: string,
  ) {}

  static exists(path: string): boolean {
    return existsSync(path);
  }

  /** Crea el archivo al instalar (enroll). */
  static async create(
    path: string,
    protector: Protector,
    a: { server: string; robotUser: string; refreshToken: string },
  ): Promise<AgentFile> {
    const f = new AgentFile(
      path,
      protector,
      a.server,
      a.robotUser,
      await protector.protect(Buffer.from(a.refreshToken)),
      await protector.protect(randomBytes(32)),
    );
    await f.write();
    return f;
  }

  static async open(path: string, protectorOverride?: Protector): Promise<AgentFile> {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const v2 = v2Schema.safeParse(raw);
    if (v2.success) {
      const d = v2.data;
      const p = protectorOverride ?? protectorFor(d.protection);
      return new AgentFile(path, p, d.server, d.robotUser, d.refreshToken, d.localKey);
    }
    const v1 = v1Schema.parse(raw);
    const p = protectorOverride ?? protectorFor(process.platform === 'win32' ? 'dpapi' : 'none');
    return AgentFile.create(path, p, { ...v1, refreshToken: v1.token });
  }

  async refreshToken(): Promise<string> {
    return (await this.protector.unprotect(this.sealedRefresh)).toString('utf8');
  }

  /** Guarda el token rotado ANTES de usar el acceso nuevo (si se cae aquí, la ventana de 60 s cubre el reintento). */
  async setRefreshToken(token: string): Promise<void> {
    this.sealedRefresh = await this.protector.protect(Buffer.from(token));
    await this.write();
  }

  async localKey(): Promise<Buffer> {
    return this.protector.unprotect(this.sealedLocalKey);
  }

  private async write() {
    const body = {
      version: 2,
      server: this.server,
      robotUser: this.robotUser,
      protection: this.protector.kind,
      refreshToken: this.sealedRefresh,
      localKey: this.sealedLocalKey,
    };
    // Escritura atómica: nunca queda un robot.json a medias.
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.path);
  }
}
