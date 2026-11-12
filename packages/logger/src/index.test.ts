import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, scrubText } from './index.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('logger', () => {
  it('enmascara teléfonos y documentos en texto libre', () => {
    expect(scrubText('llamar al 3001234567 cc 1020304050')).toBe('llamar al [TEL] cc [NUM]');
  });

  it('enmascara correos, también con dígitos y subdominios', () => {
    expect(scrubText('mi correo es juan.perez+claro@mail.empresa.com.co gracias')).toBe(
      'mi correo es [CORREO] gracias',
    );
    expect(scrubText('ana1020304050@gmail.com y 3001234567')).toBe('[CORREO] y [TEL]');
    expect(scrubText('el plan de 52.900 sin @ no cambia')).toBe(
      'el plan de 52.900 sin @ no cambia',
    );
  });

  it('no deja correos en el mensaje del log', () => {
    const { lines, stream } = capture();
    createLogger('test', { level: 'info' }, stream).info('cliente ana@correo.com');
    expect(lines.join('')).not.toContain('ana@correo.com');
  });

  it('redacta campos sensibles y enmascara el mensaje', () => {
    const { lines, stream } = capture();
    const log = createLogger('test', { level: 'info' }, stream);
    log.info({ password: 'x', user: { phone: '3001234567' }, chatId: 'c1' }, 'cliente 3109876543');
    const out = lines.join('');
    expect(out).not.toContain('3001234567');
    expect(out).not.toContain('3109876543');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('c1');
    expect(JSON.parse(out).name).toBe('test');
  });

  it('D-046: la clave name del objeto no sale en claro; el nombre del logger sí', () => {
    const { lines, stream } = capture();
    createLogger('robot', { level: 'info' }, stream).info({ name: 'Pedro Pruebas', chatId: 'c1' });
    const out = lines.join('');
    expect(out).not.toContain('Pedro');
    expect(JSON.parse(out).name).toBe('robot');
    expect(JSON.parse(out).nameRedacted).toBe('[REDACTED]');
  });

  it('D-046: enmascara el nombre que da el cliente en texto libre', () => {
    expect(scrubText('hola, me llamo Pedro Pruebas Sintético')).toBe('hola, me llamo [NOMBRE]');
    expect(scrubText('Mi nombre completo es ana maría lópez')).toBe(
      'Mi nombre completo es [NOMBRE]',
    );
    expect(scrubText('nombre: Juan Pérez, cc 1020304050')).toBe('nombre: [NOMBRE], cc [NUM]');
    expect(scrubText('el plan de 52.900 incluye redes')).toBe('el plan de 52.900 incluye redes');
  });
});
