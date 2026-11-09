import type { RobotActivity } from '@abaya/robot-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityReporter } from './activity-reporter.js';

// D-032: lo que hace el robot llega al servidor resumido y sin frenar las acciones.

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-20T15:00:00Z') }));
afterEach(() => vi.useRealTimers());

function reporter(send: (a: RobotActivity) => void = () => undefined) {
  const sent: RobotActivity[] = [];
  const r = new ActivityReporter({
    send: (a) => {
      sent.push(a);
      send(a);
    },
    queued: () => 2,
    throttleMs: 250,
    heartbeatMs: 20_000,
  });
  return { r, sent };
}

describe('ActivityReporter', () => {
  it('al arrancar informa IDLE; las acciones seguidas se resumen en la última', () => {
    const { r, sent } = reporter();
    r.start();
    expect(sent.map((a) => a.action)).toEqual(['IDLE']);

    r.update('READ_INBOX', null);
    r.update('IDLE', null);
    r.update('SEND', 'chat-1');
    vi.advanceTimersByTime(250);
    expect(sent.at(-1)).toMatchObject({ action: 'SEND', abayaChatId: 'chat-1', queued: 2 });
    expect(sent).toHaveLength(2);
    r.stop();
  });

  it('la misma acción en el mismo chat conserva desde cuándo', () => {
    const { r, sent } = reporter();
    r.update('SEND', 'chat-1');
    vi.advanceTimersByTime(250);
    const since = sent.at(-1)!.since;
    vi.advanceTimersByTime(5_000);
    r.update('SEND', 'chat-1');
    vi.advanceTimersByTime(250);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.since).toBe(since);
  });

  it('revisar la bandeja no reinicia «libre desde»; un envío sí', () => {
    const { r, sent } = reporter();
    r.start();
    const idleSince = sent[0]!.since;
    vi.advanceTimersByTime(15_000);
    r.update('READ_INBOX', null);
    vi.advanceTimersByTime(250);
    r.update('IDLE', null);
    vi.advanceTimersByTime(250);
    expect(sent.at(-1)).toMatchObject({ action: 'IDLE', since: idleSince });

    r.update('SEND', 'chat-1');
    vi.advanceTimersByTime(250);
    r.update('IDLE', null);
    vi.advanceTimersByTime(250);
    expect(sent.at(-1)!.since).not.toBe(idleSince);
    r.stop();
  });

  it('latido: reenvía aunque no cambie (la actividad vence en el servidor)', () => {
    const { r, sent } = reporter();
    r.start();
    vi.advanceTimersByTime(40_000);
    expect(sent).toHaveLength(3);
    r.stop();
  });

  it('un envío que falla no rompe nada', () => {
    const { r } = reporter(() => {
      throw new Error('sin conexión');
    });
    expect(() => r.start()).not.toThrow();
    r.update('CLOSE', 'chat-9');
    expect(() => vi.advanceTimersByTime(250)).not.toThrow();
    r.stop();
  });
});
