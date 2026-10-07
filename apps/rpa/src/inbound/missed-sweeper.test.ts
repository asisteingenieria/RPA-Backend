import { createLogger } from '@abaya/logger';
import { describe, expect, it } from 'vitest';
import { MissedMessageSweeper, type SweepActor, type SweepRepository } from './missed-sweeper.js';

function setup(inbox: { abayaChatId: string; unread: number }[], idle: string[]) {
  const opened: string[] = [];
  let t = 1_000_000;
  const actor: SweepActor = {
    readInbox: async () => inbox,
    openChat: async (id) => {
      opened.push(id);
      return true;
    },
  };
  const asked: string[][] = [];
  const repo: SweepRepository = {
    idleChats: async (_r, ids) => {
      asked.push(ids);
      return ids.filter((id) => idle.includes(id));
    },
  };
  const sweeper = new MissedMessageSweeper({
    robotUser: 'robot-01',
    actor,
    repo,
    logger: createLogger('t', { level: 'silent' }),
    now: () => t,
  });
  return { sweeper, opened, asked, advance: (ms: number) => (t += ms) };
}

describe('MissedMessageSweeper', () => {
  it('abre solo los chats con no leídos que el sistema no tiene en curso', async () => {
    const s = setup(
      [
        { abayaChatId: 'A', unread: 1 }, // mensaje perdido
        { abayaChatId: 'B', unread: 2 }, // el robot ya lo tiene en curso
        { abayaChatId: 'C', unread: 0 }, // al día
      ],
      ['A'],
    );
    expect(await s.sweeper.sweep()).toEqual(['A']);
    expect(s.asked).toEqual([['A', 'B']]);
    expect(s.opened).toEqual(['A']);
    expect(s.sweeper.recovered).toBe(1);
  });

  it('sin no leídos no consulta la base ni abre nada', async () => {
    const s = setup([{ abayaChatId: 'A', unread: 0 }], ['A']);
    expect(await s.sweeper.sweep()).toEqual([]);
    expect(s.asked).toEqual([]);
  });

  it('no reabre el mismo chat antes de 30 s', async () => {
    const s = setup([{ abayaChatId: 'A', unread: 1 }], ['A']);
    await s.sweeper.sweep();
    s.advance(15_000);
    expect(await s.sweeper.sweep()).toEqual([]);
    s.advance(16_000);
    expect(await s.sweeper.sweep()).toEqual(['A']);
    expect(s.opened).toEqual(['A', 'A']);
  });
});
