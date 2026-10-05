import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regla 4 (y 3) verificadas de forma estática:
 * - Solo el BrowserActor invoca métodos de page objects que modifican la interfaz.
 * - Solo selectors.ts define selectores.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

const rel = (p: string) => relative(SRC, p).split(sep).join('/');
const sources = files(SRC).map((p) => ({ path: rel(p), code: readFileSync(p, 'utf8') }));

const MUTATING_CALL = /\.(typeMessage|clickSend|closeChat|writeNote|transferTo)\(/;
const MUTATING_PAGES = /import\s+\{[^}]*\b(ChatListPage|NotePage|TransferPage)\b[^}]*\}\s+from/;
const SELECTOR_CALL =
  /\.(getByRole|getByLabel|getByText|getByTestId|locator|querySelector(All)?)\(/;

describe('regla 4: solo el BrowserActor modifica la interfaz', () => {
  it('ningún archivo fuera de actor/ invoca métodos que modifican la interfaz', () => {
    const offenders = sources
      .filter((s) => !s.path.startsWith('actor/') && !s.path.startsWith('abaya/pages/'))
      .filter((s) => MUTATING_CALL.test(s.code))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it('solo actor/ importa page objects con acciones (lista, nota, transferencia)', () => {
    const offenders = sources
      .filter((s) => !s.path.startsWith('actor/') && !s.path.startsWith('abaya/pages/'))
      .filter((s) => MUTATING_PAGES.test(s.code))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });
});

describe('regla 3: selectores solo en selectors.ts', () => {
  it('ningún archivo fuera de selectors.ts construye selectores', () => {
    const allowed = new Set(['abaya/selectors.ts']);
    const offenders = sources
      .filter((s) => !allowed.has(s.path))
      // El observador del DOM recibe sus selectores desde selectors.ts como parámetros.
      .filter((s) => SELECTOR_CALL.test(s.code.replace(/querySelectorAll?\(cfg\.\w+\)/g, '')))
      .map((s) => s.path);
    expect(offenders).toEqual([]);
  });
});
