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
});
