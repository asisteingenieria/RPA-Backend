#!/usr/bin/env node
/**
 * Arma el paquete instalador del robot hijo para Windows (v1.4, sección 2.6):
 *
 *   pnpm robot:package                    # paquete liviano: el navegador se descarga al instalar
 *   pnpm robot:package --con-navegador    # incluye Chromium (equipos sin salida a Internet)
 *   pnpm robot:package --node-exe <ruta>  # node.exe de Windows (obligatorio si no se arma en Windows)
 *
 * Resultado: dist/robot-package/abaya-robot-windows.zip, que el panel ofrece para descargar, y
 * su manifiesto firmado (v1.7) abaya-robot-windows.zip.manifest.json: los robots solo instalan
 * paquetes con firma válida. Requiere la clave privada de publicación (pnpm robot:keys).
 * El paquete NO contiene secretos: solo código, Node.js, la clave PÚBLICA y el instalador.
 */
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BASE = join(ROOT, 'dist', 'robot-package');
const OUT = join(OUT_BASE, 'abaya-robot');
const ZIP = join(OUT_BASE, 'abaya-robot-windows.zip');
const INSTALLER = join(ROOT, 'apps', 'rpa', 'installer');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const withBrowser = args.includes('--con-navegador');
const nodeExeArg = args.includes('--node-exe') ? args[args.indexOf('--node-exe') + 1] : undefined;

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: isWin, ...opts });
  if (r.status !== 0) {
    console.error(`Falló: ${cmd} ${cmdArgs.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

// Firma (v1.7): sin la clave privada no se publica nada; y debe corresponder con la pública
// que viaja dentro del robot (si no, los robots rechazarían sus propias actualizaciones).
const KEY_FILE =
  process.env.ROBOT_RELEASE_KEY_FILE ?? join(ROOT, '.secrets', 'release-signing.key');
const PUB_FILE = join(ROOT, 'apps', 'rpa', 'release-key.pub');
if (!existsSync(KEY_FILE) || !existsSync(PUB_FILE)) {
  console.error('Falta la clave de publicación. Generarla una vez con: pnpm robot:keys');
  process.exit(1);
}
const privatePem = readFileSync(KEY_FILE, 'utf8');
const derived = createPublicKey(createPrivateKey(privatePem)).export({
  type: 'spki',
  format: 'pem',
});
if (derived.toString().trim() !== readFileSync(PUB_FILE, 'utf8').trim()) {
  console.error('La clave privada no corresponde con apps/rpa/release-key.pub');
  process.exit(1);
}

const nodeExe = nodeExeArg ?? (isWin ? process.execPath : undefined);
if (!nodeExe || !existsSync(nodeExe)) {
  console.error(
    'Se necesita node.exe de Windows: arme el paquete en Windows o use --node-exe <ruta>',
  );
  process.exit(1);
}

console.log('[paquete] compilando el robot');
rmSync(join(ROOT, 'apps', 'rpa', 'dist'), { recursive: true, force: true });
run('pnpm', ['turbo', 'run', 'build', '--filter=@abaya/rpa...', '--force']);

console.log('[paquete] armando la aplicación con sus dependencias');
rmSync(OUT_BASE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// node_modules plano (sin enlaces): se puede comprimir y copiar a cualquier equipo.
// `pnpm deploy` con estas opciones reescribe el estado de la instalación del repositorio
// (lo marca como de producción y la siguiente orden de pnpm intenta reinstalar): se respalda
// y se restaura.
const STATE = join(ROOT, 'node_modules', '.pnpm-workspace-state-v1.json');
const savedState = existsSync(STATE) ? readFileSync(STATE) : undefined;
try {
  run('pnpm', [
    'deploy',
    '--legacy',
    '--filter=@abaya/rpa',
    '--prod',
    '--config.node-linker=hoisted',
    join(OUT, 'app'),
  ]);
} finally {
  if (savedState) writeFileSync(STATE, savedState);
}

// Versión visible en el panel: la del paquete + commit.
const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
const pkgPath = join(OUT, 'app', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const sha = git.status === 0 ? git.stdout.trim() : 'sin-git';
// Versión única por armado: paquete + commit + fecha (un robot solo se actualiza si cambia).
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
pkg.version = `${pkg.version}+${sha}.${stamp}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log('[paquete] copiando Node.js');
mkdirSync(join(OUT, 'node'), { recursive: true });
copyFileSync(nodeExe, join(OUT, 'node', 'node.exe'));

console.log('[paquete] copiando el instalador');
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
for (const f of ['instalar.cmd', 'iniciar.cmd', 'desinstalar.cmd', 'actualizar.cmd', 'LEEME.txt']) {
  writeFileSync(join(OUT, f), crlf(readFileSync(join(INSTALLER, f), 'utf8')));
}
// Windows PowerShell 5.1 lee los .ps1 sin BOM como ANSI: con BOM se respetan las tildes.
for (const f of ['instalar.ps1', 'iniciar.ps1', 'desinstalar.ps1']) {
  writeFileSync(join(OUT, f), '\ufeff' + crlf(readFileSync(join(INSTALLER, f), 'utf8')));
}
writeFileSync(
  join(OUT, 'VERSION'),
  `abaya-robot ${pkg.version}\r\nArmado: ${new Date().toISOString()}\r\nNode.js: ${process.version}\r\n`,
);

if (withBrowser) {
  console.log('[paquete] incluyendo Chromium');
  run(
    process.execPath,
    [join(OUT, 'app', 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
    {
      shell: false,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(OUT, 'navegador') },
    },
  );
}

console.log('[paquete] comprimiendo');
if (isWin) {
  // tar.exe de Windows (bsdtar) sabe crear .zip; el de Git Bash no.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  run(tar, ['-a', '-cf', ZIP, '-C', OUT_BASE, 'abaya-robot'], { shell: false });
} else {
  run('zip', ['-qr', ZIP, 'abaya-robot'], { cwd: OUT_BASE, shell: false });
}

// Manifiesto firmado (v1.7): versión, SHA-256 y tamaño del zip.
const { signRelease } = await import(
  pathToFileURL(join(ROOT, 'packages', 'robot-store', 'dist', 'index.js')).href
);
const zipBytes = readFileSync(ZIP);
const signed = signRelease(
  {
    product: 'abaya-robot',
    version: pkg.version,
    sha256: createHash('sha256').update(zipBytes).digest('hex'),
    size: zipBytes.length,
    builtAt: new Date().toISOString(),
  },
  privatePem,
);
writeFileSync(`${ZIP}.manifest.json`, JSON.stringify(signed, null, 2) + '\n');

console.log(`\nPaquete listo: ${ZIP}\nVersión: ${pkg.version}\nFirmado: ${ZIP}.manifest.json`);
