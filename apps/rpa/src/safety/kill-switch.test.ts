import { describe, expect, it } from 'vitest';
import { RedisKillSwitch } from './kill-switch.js';

function fakeRedis(values: Record<string, string>, fail = false) {
  return {
    mget: async (...keys: string[]) => {
      if (fail) throw new Error('sin conexión');
      return keys.map((k) => values[k] ?? null);
    },
    set: async () => 'OK' as const,
    quit: async () => 'OK' as const,
  };
}

describe('RedisKillSwitch', () => {
  it('bloquea con el kill switch global', async () => {
    const ks = new RedisKillSwitch(fakeRedis({ 'abaya:killswitch': '1' }) as never, 'robot-01');
    expect(await ks.isActive()).toBe(true);
  });

  it('bloquea solo al robot pausado', async () => {
    const values = { 'abaya:pause:robot-01': '1' };
    expect(await new RedisKillSwitch(fakeRedis(values) as never, 'robot-01').isActive()).toBe(true);
    expect(await new RedisKillSwitch(fakeRedis(values) as never, 'robot-02').isActive()).toBe(
      false,
    );
  });

  it('falla cerrado si Redis no responde', async () => {
    const ks = new RedisKillSwitch(fakeRedis({}, true) as never, 'robot-01');
    expect(await ks.isActive()).toBe(true);
  });
});
