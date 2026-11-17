import { randomBytes } from 'node:crypto';
import { FieldCipher } from '@abaya/crypto';
import { audioAad, inboundAad, type InboundMessage } from '@abaya/domain';
import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import { InboundProcessor, messageFingerprint } from './inbound-processor.js';
import type { MediaFetcher } from './media-fetcher.js';
import { MemoryInboundQueue } from './inbound-queue.js';
import { MemoryInboundRepository } from './inbound.repository.js';

const cipher = new FieldCipher(randomBytes(32).toString('base64'));

function setup() {
  const repo = new MemoryInboundRepository();
  const queue = new MemoryInboundQueue();
  const p = new InboundProcessor({
    robotUser: 'robot-ventas-01',
    repo,
    queue,
    cipher,
    logger: createLogger('t', { level: 'silent' }),
  });
  return { p, repo, queue };
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  abayaChatId: 'CH-1',
  messageId: 'm-1',
  sender: 'CUSTOMER',
  text: 'Hola, quiero un plan',
  occurredAt: new Date('2026-10-05T14:00:00Z'),
  ...over,
});

describe('InboundProcessor', () => {
  it('mensaje detectado por red y por DOM se guarda una sola vez', async () => {
    const { p, repo, queue } = setup();
    await Promise.all([p.handle(msg(), 'network'), p.handle(msg(), 'dom')]);
    await p.drain();
    expect(repo.messages.size).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(p.stats).toMatchObject({ stored: 1, duplicates: 1 });
  });

  it('la base de datos deduplica aunque el proceso reinicie (sin caché)', async () => {
    const a = setup();
    await a.p.handle(msg(), 'network');
    const b = new InboundProcessor({
      robotUser: 'robot-ventas-01',
      repo: a.repo,
      queue: a.queue,
      cipher,
      logger: createLogger('t', { level: 'silent' }),
    });
    await b.handle(msg(), 'dom');
    expect(a.repo.messages.size).toBe(1);
    expect(b.stats.duplicates).toBe(1);
  });

  it('ignora mensajes propios del robot', async () => {
    const { p, repo, queue } = setup();
    await p.handle(msg({ sender: 'AGENT' }), 'network');
    expect(repo.messages.size).toBe(0);
    expect(queue.jobs).toHaveLength(0);
    expect(p.stats.ignoredOwn).toBe(1);
  });

  it('D-036: no guarda lo que el cliente le escribió al bot yFlow (ni por red ni por DOM)', async () => {
    const { p, repo, queue } = setup();
    p.markBeforeHandoff('CH-1', ['m-1']);
    await p.handle(
      msg({
        text: '',
        media: { kind: 'AUDIO', url: 'https://abaya.test/a.ogg', mimeType: 'audio/ogg' },
      }),
      'network',
    );
    await p.handle(msg({ text: '0:12' }), 'dom');
    await p.handle(msg({ messageId: 'm-2', text: 'Hola, ¿sigues ahí?' }), 'network');
    expect(repo.messages.size).toBe(1);
    expect(queue.jobs).toHaveLength(1);
    expect(p.stats).toMatchObject({ ignoredBeforeHandoff: 1, stored: 1 });
  });

  it('ignora mensajes del sistema', async () => {
    const { p, repo } = setup();
    await p.handle(msg({ sender: 'SYSTEM' }), 'dom');
    expect(repo.messages.size).toBe(0);
    expect(p.stats.ignoredSystem).toBe(1);
  });

  it('chat nuevo crea Conversation (por asignación o por primer mensaje)', async () => {
    const { p, repo } = setup();
    await p.chatAssigned('CH-9');
    await p.chatAssigned('CH-9');
    await p.handle(msg({ abayaChatId: 'CH-10' }), 'network');
    expect([...repo.conversations.keys()]).toEqual(['CH-9', 'CH-10']);
    expect(p.stats.newConversations).toBe(2);
  });

  it('D-017: un caso recién asignado programa la apertura (una sola vez)', async () => {
    const { p, queue } = setup();
    await p.chatAssigned('CH-11');
    await p.chatAssigned('CH-11');
    expect(queue.jobs).toEqual([expect.objectContaining({ abayaChatId: 'CH-11', opening: true })]);
    expect(queue.jobs[0]!.messageId).toBeUndefined();
  });

  it('guarda el texto cifrado, nunca en claro', async () => {
    const { p, repo } = setup();
    await p.handle(msg(), 'network');
    const stored = [...repo.messages.values()][0]!;
    expect(stored.bodyEncrypted.toString('latin1')).not.toContain('Hola');
    expect(cipher.decryptString(stored.bodyEncrypted, `msg:${stored.fingerprint}`)).toBe(
      'Hola, quiero un plan',
    );
  });

  it('huella: con id usa chat + id; sin id usa contenido y posición', () => {
    expect(messageFingerprint(msg({ text: 'a' }))).toBe(messageFingerprint(msg({ text: 'b' })));
    const noId = { ...msg(), messageId: undefined };
    expect(messageFingerprint({ ...noId, position: 1 })).not.toBe(
      messageFingerprint({ ...noId, position: 2 }),
    );
    expect(messageFingerprint(msg({ abayaChatId: 'CH-2' }))).not.toBe(messageFingerprint(msg()));
  });

  it('mensajes distintos del mismo chat se guardan en orden y se encolan', async () => {
    const { p, queue } = setup();
    for (let i = 0; i < 5; i++) void p.handle(msg({ messageId: `m-${i}` }), 'network');
    await p.drain();
    expect(queue.jobs).toHaveLength(5);
  });
});

describe('D-010 / D-047: adjuntos del cliente', () => {
  function withMedia(fetcher?: MediaFetcher) {
    const repo = new MemoryInboundRepository();
    const queue = new MemoryInboundQueue();
    const p = new InboundProcessor({
      robotUser: 'robot-ventas-01',
      repo,
      queue,
      cipher,
      logger: createLogger('t', { level: 'silent' }),
      ...(fetcher ? { media: fetcher } : {}),
      domEmptyWaitMs: 20,
    });
    return { p, repo, queue };
  }
  const bytes = Buffer.from('archivo');
  const fetcher: MediaFetcher = { fetch: async () => ({ data: bytes, mimeType: 'audio/ogg' }) };

  it('nota de voz: descarga el audio y lo guarda cifrado, sin texto', async () => {
    const { p, repo } = withMedia(fetcher);
    await p.handle(
      msg({ text: '', media: { kind: 'AUDIO', url: 'https://x.blob.core.windows.net/a.ogg' } }),
      'network',
    );
    const [m] = [...repo.messages.values()];
    expect(m!.media).toMatchObject({ kind: 'AUDIO', mimeType: 'audio/ogg' });
    expect(cipher.decrypt(m!.media!.audioEncrypted!, audioAad(m!.fingerprint))).toEqual(bytes);
    expect(cipher.decryptString(m!.bodyEncrypted, inboundAad(m!.fingerprint))).toBe('');
  });

  it('imagen con pie de foto: dos mensajes (texto y la imagen sin texto)', async () => {
    const { p, repo, queue } = withMedia({
      fetch: async () => ({ data: bytes, mimeType: 'image/jpeg' }),
    });
    await p.handle(
      msg({
        text: 'este es mi plan',
        media: {
          kind: 'IMAGE',
          url: 'https://x.blob.core.windows.net/i.jpg',
          mimeType: 'image/jpeg',
        },
      }),
      'network',
    );
    const stored = [...repo.messages.values()];
    expect(stored).toHaveLength(2);
    expect(cipher.decryptString(stored[0]!.bodyEncrypted, inboundAad(stored[0]!.fingerprint))).toBe(
      'este es mi plan',
    );
    expect(stored[0]!.media).toBeUndefined();
    expect(stored[1]!.media).toMatchObject({ kind: 'IMAGE', mimeType: 'image/jpeg' });
    expect(queue.jobs).toHaveLength(2);
  });

  it('no se pudo descargar: se guarda igual, sin archivo (el worker pide escribir)', async () => {
    const { p, repo } = withMedia({ fetch: async () => null });
    await p.handle(
      msg({ text: '', media: { kind: 'IMAGE', url: 'https://x.blob.core.windows.net/i.jpg' } }),
      'network',
    );
    const [m] = [...repo.messages.values()];
    expect(m!.media).toMatchObject({ kind: 'IMAGE', audioEncrypted: null });
  });

  it('fila vacía del DOM: espera a la red, que trae el archivo (misma huella)', async () => {
    const { p, repo } = withMedia(fetcher);
    await p.handle(msg({ text: '' }), 'dom');
    await p.handle(
      msg({ text: '', media: { kind: 'AUDIO', url: 'https://x.blob.core.windows.net/a.ogg' } }),
      'network',
    );
    await new Promise((r) => setTimeout(r, 40));
    await p.drain();
    const stored = [...repo.messages.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.media).toMatchObject({ kind: 'AUDIO' });
  });
});
