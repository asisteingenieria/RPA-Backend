import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D-046 (regla 6): ninguna llamada al logger del código de producción lleva campos del cliente.
 * El logger ya redacta claves sensibles y enmascara el texto, pero la primera defensa es no
 * registrarlos: aquí se revisa el código fuente de las apps y paquetes.
 */
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DIRS = ['apps', 'packages'];
const SKIP =
  /(^|[\\/])(node_modules|dist|generated|test|tests|fixtures)([\\/]|$)|\.test\.ts$|\.pw\.ts$/;

/** Campos del cliente que no pueden aparecer en una llamada al logger. */
const FORBIDDEN =
  /\b(text|body|profile|saleFullName|saleDocument|saleEmail|salePhone|saleCity|customerReply|customerText|summary|transcript|caption)\b/;
const CALL = /\b(?:logger|log)\s*\.\s*(?:trace|debug|info|warn|error|fatal)\s*\(/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(relative(ROOT, p))) continue;
    const st = statSync(p);
    if (st.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Argumentos de la llamada (hasta cerrar el paréntesis), sin el texto de los strings. */
function callArgs(src: string, start: number): string {
  let depth = 0;
  let i = start;
  let out = '';
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += '""';
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) break;
    }
    out += ch;
  }
  return out;
}

/** Llamadas al logger de un fuente que llevan campos del cliente. */
function offending(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(CALL)) {
    const args = callArgs(src, m.index! + m[0].length - 1);
    if (FORBIDDEN.test(args)) out.push(args);
  }
  return out;
}

describe('D-046: logs sin datos del cliente', () => {
  it('el detector encuentra campos del cliente y no confunde el texto del mensaje', () => {
    expect(offending("this.d.logger.info({ text: m.text }, 'x');")).toHaveLength(1);
    expect(offending('log.warn({ chat, profile }, "perfil");')).toHaveLength(1);
    expect(
      offending("logger.info({ id, err: err.name }, 'texto del mensaje (body) vacío');"),
    ).toEqual([]);
  });

  it('ninguna llamada al logger del código de producción registra campos del cliente', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const d of DIRS) {
      for (const file of sources(join(ROOT, d, ''))) {
        if (!/[\\/]src[\\/]/.test(file)) continue;
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(CALL)) {
          calls++;
          const args = callArgs(src, m.index! + m[0].length - 1);
          if (FORBIDDEN.test(args)) {
            const line = src.slice(0, m.index).split('\n').length;
            offenders.push(`${relative(ROOT, file)}:${line} → ${args.slice(0, 120)}`);
          }
        }
      }
    }
    expect(calls).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
