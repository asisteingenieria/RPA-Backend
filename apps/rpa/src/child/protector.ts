import { spawn } from 'node:child_process';

/**
 * Protección de los secretos del equipo (token de renovación y clave local) en `robot.json`
 * (v1.6, sección 2.8). En Windows, DPAPI ligado al usuario de Windows: el archivo copiado a
 * otro equipo o abierto por otro usuario no sirve.
 */
export interface Protector {
  readonly kind: 'dpapi' | 'none';
  protect(data: Buffer): Promise<string>;
  unprotect(protectedB64: string): Promise<Buffer>;
}

/** Entropía propia de la aplicación: otro programa del mismo usuario no lo descifra por error. */
const ENTROPY_B64 = Buffer.from('abaya-rpa-robot-v1').toString('base64');

function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += String(d)));
    ps.stderr.on('data', (d) => (err += String(d)));
    ps.on('error', reject);
    ps.on('close', (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(`DPAPI falló (${code}): ${err.trim().slice(0, 200)}`)),
    );
    // El secreto va por la entrada estándar, nunca por la línea de comandos.
    ps.stdin.end(input);
  });
}

const dpapi = (method: 'Protect' | 'Unprotect') =>
  `Add-Type -AssemblyName System.Security;` +
  `$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());` +
  `$e=[Convert]::FromBase64String('${ENTROPY_B64}');` +
  `$r=[Security.Cryptography.ProtectedData]::${method}($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  `[Console]::Out.Write([Convert]::ToBase64String($r))`;

export class DpapiProtector implements Protector {
  readonly kind = 'dpapi' as const;
  async protect(data: Buffer) {
    return powershell(dpapi('Protect'), data.toString('base64'));
  }
  async unprotect(b64: string) {
    return Buffer.from(await powershell(dpapi('Unprotect'), b64), 'base64');
  }
}

/**
 * Sin protección: SOLO pruebas automáticas y equipos no Windows (contenedor Linux), donde la
 * carpeta del robot debe ser legible solo por su usuario. Se exige declararlo explícitamente.
 */
export class PlainProtector implements Protector {
  readonly kind = 'none' as const;
  async protect(data: Buffer) {
    return data.toString('base64');
  }
  async unprotect(b64: string) {
    return Buffer.from(b64, 'base64');
  }
}

export function protectorFor(
  kind: 'dpapi' | 'none',
  env: NodeJS.ProcessEnv = process.env,
): Protector {
  if (kind === 'dpapi') return new DpapiProtector();
  if (env.ROBOT_ALLOW_UNPROTECTED !== '1') {
    throw new Error(
      'robot.json sin protección DPAPI: solo se permite con ROBOT_ALLOW_UNPROTECTED=1 (pruebas o Linux)',
    );
  }
  return new PlainProtector();
}

/** La protección por defecto del equipo: DPAPI en Windows. */
export function defaultProtector(env: NodeJS.ProcessEnv = process.env): Protector {
  return protectorFor(process.platform === 'win32' ? 'dpapi' : 'none', env);
}
