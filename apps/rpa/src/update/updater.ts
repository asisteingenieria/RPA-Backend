import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@abaya/logger';
import { verifyRelease, type ReleaseManifest, type UpdateStatus } from '@abaya/robot-store';

/**
 * Carpeta de instalación con versiones lado a lado (v1.7, sección 2.9):
 *   versions\<versión>\{app,node}   current.txt   previous.txt   pending.txt
 *   probation.txt (versión nueva a prueba)   rollback.txt (el lanzador revirtió)
 *   solicitar-actualizacion.txt (botón local)
 * La define el lanzador (iniciar.ps1) con ROBOT_INSTALL_DIR.
 */
export class InstallLayout {
  constructor(readonly root: string) {}
  file(name: string) {
    return join(this.root, name);
  }
  versionDir(v: string) {
    return join(this.root, 'versions', safeVersion(v));
  }
  async read(name: string): Promise<string | null> {
    try {
      return (await readFile(this.file(name), 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }
  async write(name: string, value: string) {
    await writeFile(this.file(name), value + '\r\n', 'utf8');
  }
  async remove(name: string) {
    await rm(this.file(name), { force: true });
  }
}

/** Nombre de carpeta seguro para una versión (`1.1.0+abc.202610070915`). */
export function safeVersion(v: string): string {
  return v.replace(/[^\w.+-]/g, '_').slice(0, 64);
}

export interface UpdaterDeps {
  layout: InstallLayout | null;
  currentVersion: string;
  publicKeyPem: string | null;
  fetchManifest: () => Promise<unknown>;
  download: (path: string) => Promise<void>;
  report: (status: UpdateStatus, version?: string, message?: string) => Promise<void>;
  /** Ejecuta `fn` solo si el robot está libre (bandeja vacía, sin acciones). */
  runIfIdle: (fn: () => Promise<void>) => Promise<{ ran: boolean }>;
  /** Detiene acciones nuevas y apaga el proceso con el código de actualización. */
  restartForUpdate: () => void;
  logger: Logger;
  /** Pruebas: extraer el zip y preparar el navegador. */
  extract?: (zip: string, dest: string) => Promise<void>;
  installBrowser?: (versionDir: string) => Promise<void>;
}

/**
 * Actualización del robot hijo (v1.7): descarga y verifica en segundo plano (el robot sigue
 * trabajando), prepara la versión en `versions\` y, solo cuando queda libre, sale con el
 * código 4 para que el lanzador la active. La firma (Ed25519) y el SHA-256 se verifican
 * ANTES de preparar nada: un paquete que no verifica nunca se instala.
 */
export class RobotUpdater {
  private busy = false;
  private staged: string | null = null;
  private waitTimer?: NodeJS.Timeout;
  private failedVersion: string | null = null;

  constructor(private readonly d: UpdaterDeps) {}

  /** Lo pide el servidor (WebSocket) o el botón local; `target` = versión publicada. */
  async request(target: string | null): Promise<void> {
    if (!target || target === this.d.currentVersion || this.busy) return;
    if (this.staged === target || this.failedVersion === target) return;
    this.busy = true;
    try {
      await this.stage(target);
      this.waitForIdle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'error';
      this.failedVersion = target;
      this.d.logger.error({ target, err: msg }, 'actualización fallida');
      await this.d.report('FAILED', target, msg.slice(0, 300)).catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }

  /** Descarga, verifica y deja lista la versión en versions\<versión>. */
  async stage(target: string): Promise<ReleaseManifest> {
    const layout = this.d.layout;
    if (!layout) throw new Error('Instalación sin versiones: reinstale con el paquete nuevo');
    if (!this.d.publicKeyPem) throw new Error('El robot no tiene la clave pública de publicación');
    await this.d.report('DOWNLOADING', target);
    const manifest = verifyRelease(await this.d.fetchManifest(), this.d.publicKeyPem);
    if (!manifest) throw new Error('Firma inválida: el paquete publicado no es de confianza');
    if (manifest.version !== target) {
      throw new Error(`El servidor publica ${manifest.version}, no ${target}`);
    }
    const work = join(layout.root, 'descargas');
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const zip = join(work, 'paquete.zip');
    await this.d.download(zip);
    const digest = await sha256File(zip);
    if (digest !== manifest.sha256) throw new Error('El paquete descargado no coincide (SHA-256)');

    const extracted = join(work, 'extraido');
    await mkdir(extracted, { recursive: true });
    await (this.d.extract ?? extractZip)(zip, extracted);
    const src = join(extracted, 'abaya-robot');
    if (!existsSync(join(src, 'app', 'dist', 'main.js')) || !existsSync(join(src, 'node'))) {
      throw new Error('El paquete no tiene la estructura esperada');
    }
    const dest = layout.versionDir(manifest.version);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await rename(join(src, 'app'), join(dest, 'app'));
    await rename(join(src, 'node'), join(dest, 'node'));
    await (this.d.installBrowser ?? installBrowser(layout))(dest);
    await rm(work, { recursive: true, force: true });
    await layout.write('pending.txt', safeVersion(manifest.version));
    this.staged = manifest.version;
    await this.d.report('STAGED', manifest.version);
    this.d.logger.info({ version: manifest.version }, 'versión nueva preparada');
    return manifest;
  }

  /** Espera a que el robot quede libre para cambiar de versión (sin interrumpir ventas). */
  private waitForIdle() {
    clearTimeout(this.waitTimer);
    let reported = false;
    const tick = async () => {
      const r = await this.d
        .runIfIdle(async () => this.d.restartForUpdate())
        .catch(() => ({
          ran: false,
        }));
      if (r.ran) return;
      if (!reported) {
        reported = true;
        await this.d.report('WAITING_IDLE', this.staged ?? undefined).catch(() => undefined);
      }
      this.waitTimer = setTimeout(() => void tick(), 15_000);
    };
    void tick();
  }

  /** Al arrancar: informa la reversión (si la hubo) y deja limpia la carpeta de versiones. */
  async afterStartup(): Promise<void> {
    const layout = this.d.layout;
    if (!layout) return;
    const rolledBack = await layout.read('rollback.txt');
    if (rolledBack) {
      await layout.remove('rollback.txt');
      await this.d
        .report('ROLLED_BACK', rolledBack, 'la versión nueva no arrancó')
        .catch(() => undefined);
      this.failedVersion = rolledBack;
    }
    await this.cleanupOldVersions();
  }

  /** Confirma la versión nueva tras un tiempo en línea: el lanzador ya no la revierte. */
  async confirmIfOnProbation(): Promise<void> {
    const layout = this.d.layout;
    if (!layout || !(await layout.read('probation.txt'))) return;
    await layout.remove('probation.txt');
    await this.d.report('APPLIED', this.d.currentVersion).catch(() => undefined);
    this.d.logger.info({ version: this.d.currentVersion }, 'versión nueva confirmada');
  }

  /** Botón local (actualizar.cmd): archivo de solicitud en la carpeta de instalación. */
  async localRequestPending(): Promise<boolean> {
    const layout = this.d.layout;
    if (!layout || !existsSync(layout.file('solicitar-actualizacion.txt'))) return false;
    await layout.remove('solicitar-actualizacion.txt');
    return true;
  }

  stop() {
    clearTimeout(this.waitTimer);
  }

  /** Conserva la vigente, la anterior y la pendiente; borra las demás. */
  private async cleanupOldVersions() {
    const layout = this.d.layout!;
    const keep = new Set(
      (
        await Promise.all(['current.txt', 'previous.txt', 'pending.txt'].map((f) => layout.read(f)))
      ).filter((v): v is string => !!v),
    );
    const dir = join(layout.root, 'versions');
    for (const v of await readdir(dir).catch(() => [] as string[])) {
      if (!keep.has(v)) await rm(join(dir, v), { recursive: true, force: true });
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: env ?? process.env });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} falló (${code}): ${err.slice(0, 200)}`)),
    );
  });
}

/** tar.exe de Windows (bsdtar) abre .zip; en Linux, unzip. */
function extractZip(zip: string, dest: string): Promise<void> {
  if (process.platform === 'win32') {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    return run(tar, ['-xf', zip, '-C', dest]);
  }
  return run('unzip', ['-q', zip, '-d', dest]);
}

/** El navegador vive en la carpeta compartida `navegador`: si la versión nueva pide otro, se baja. */
function installBrowser(layout: InstallLayout) {
  return (versionDir: string) =>
    run(
      join(versionDir, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
      [join(versionDir, 'app', 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
      { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(layout.root, 'navegador') },
    );
}
