import { describe, expect, it } from 'vitest';
import {
  DUMMY_PASSWORD_HASH,
  generateTemporaryPassword,
  hashPassword,
  passwordIssues,
  verifyPassword,
} from './password.js';

describe('contraseñas', () => {
  it('hash con sal: verifica la correcta y rechaza la incorrecta', async () => {
    const h1 = await hashPassword('una frase larga y segura');
    const h2 = await hashPassword('una frase larga y segura');
    expect(h1).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain('frase');
    expect(await verifyPassword('una frase larga y segura', h1)).toBe(true);
    expect(await verifyPassword('una frase larga y segurA', h1)).toBe(false);
  });

  it('un hash mal formado nunca valida', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'md5$abc')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$AA==$AA==')).toBe(false);
  });

  it('el hash ficticio tiene el formato real (mismo costo de cálculo) y no valida', async () => {
    expect(Buffer.from(DUMMY_PASSWORD_HASH.split('$')[5]!, 'base64')).toHaveLength(32);
    expect(await verifyPassword('cualquier-cosa-larga', DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it('política: longitud, usuario, variedad y palabras comunes', () => {
    expect(passwordIssues('corta')).toContain('Debe tener al menos 12 caracteres');
    expect(passwordIssues('mi-usuario.juan-2026', 'juan')).toContain(
      'No puede contener el nombre de usuario',
    );
    expect(passwordIssues('aaaaaaaaaaaaaaaa')).toContain('Tiene muy pocos caracteres distintos');
    expect(passwordIssues('MiPassword-larga-2026')).toContain(
      'Contiene una palabra demasiado común',
    );
    expect(passwordIssues('x'.repeat(129)).join()).toMatch(/como máximo/);
    expect(passwordIssues('caballo correcto batería grapa', 'juan')).toEqual([]);
  });

  it('las temporales son aleatorias, sin caracteres ambiguos y cumplen la política', () => {
    const a = generateTemporaryPassword();
    expect(a).toHaveLength(16);
    expect(a).not.toMatch(/[0O1lI]/);
    expect(a).not.toBe(generateTemporaryPassword());
    expect(passwordIssues(a)).toEqual([]);
  });
});
