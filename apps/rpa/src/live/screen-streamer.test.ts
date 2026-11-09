import { createLogger } from '@abaya/logger';
import { SCREEN_FRAME_MAX_B64, type ScreenFrame } from '@abaya/robot-store';
import type { Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenStreamer, type CdpLike, type ScreencastFrameEvent } from './screen-streamer.js';

// D-032: la pantalla sale solo mientras alguien mira, con tope de imágenes y sin tocar Abaya.

const silent = createLogger('t', { level: 'silent' });

class FakeCdp implements CdpLike {
  calls: string[] = [];
  handler?: (ev: ScreencastFrameEvent) => void;
  detached = false;
  async send(method: string) {
    this.calls.push(method);
    if (method === 'Page.captureScreenshot') return { data: 'captura' };
    return {};
  }
  onFrame(h: (ev: ScreencastFrameEvent) => void) {
    this.handler = h;
  }
  async detach() {
    this.detached = true;
  }
  frame(data: string, sessionId = 1) {
    this.handler?.({ data, sessionId, metadata: { deviceWidth: 1280, deviceHeight: 720 } });
  }
}

const fakePage = () => ({ viewportSize: () => ({ width: 1280, height: 720 }) }) as unknown as Page;

function setup(page: { current?: Page } = { current: fakePage() }) {
  const sessions: FakeCdp[] = [];
  const frames: ScreenFrame[] = [];
  const s = new ScreenStreamer({
    page: () => page.current,
    emit: (f) => frames.push(f),
    logger: silent,
    openCdp: async () => {
      const c = new FakeCdp();
      sessions.push(c);
      return c;
    },
    maxFps: 2,
    keyframeMs: 5_000,
    tickMs: 1_000,
  });
  return { s, sessions, frames, page };
}

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-20T15:00:00Z') }));
afterEach(() => vi.useRealTimers());

describe('ScreenStreamer', () => {
  it('sin nadie mirando no abre nada', async () => {
    const { s, sessions } = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessions).toHaveLength(0);
    expect(s.streaming).toBe(false);
  });

  it('al mirar: screencast + primera imagen; al dejar de mirar se detiene', async () => {
    const { s, sessions, frames } = setup();
    s.setWatched(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions[0]!.calls).toEqual(['Page.startScreencast', 'Page.captureScreenshot']);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ jpeg: 'captura', width: 1280, height: 720 });

    s.setWatched(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions[0]!.calls.at(-1)).toBe('Page.stopScreencast');
    expect(sessions[0]!.detached).toBe(true);
    sessions[0]!.frame('tarde');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames).toHaveLength(1);
  });

  it('confirma cada imagen (ack) y envía como máximo 2 por segundo: la última gana', async () => {
    const { s, sessions, frames } = setup();
    s.setWatched(true);
    await vi.advanceTimersByTimeAsync(0);
    const cdp = sessions[0]!;
    for (let i = 0; i < 10; i++) cdp.frame(`f${i}`, i);
    await vi.advanceTimersByTimeAsync(0);
    expect(cdp.calls.filter((c) => c === 'Page.screencastFrameAck')).toHaveLength(10);
    expect(frames).toHaveLength(1); // la captura inicial; el resto espera su turno
    await vi.advanceTimersByTimeAsync(500);
    expect(frames.map((f) => f.jpeg)).toEqual(['captura', 'f9']);
    await s.stop();
  });

  it('descarta imágenes demasiado grandes para la pasarela', async () => {
    const { s, sessions, frames } = setup();
    s.setWatched(true);
    await vi.advanceTimersByTimeAsync(600);
    sessions[0]!.frame('x'.repeat(SCREEN_FRAME_MAX_B64 + 1));
    await vi.advanceTimersByTimeAsync(600);
    expect(frames.map((f) => f.jpeg)).toEqual(['captura']);
    await s.stop();
  });

  it('pantalla quieta: una imagen cada 5 s', async () => {
    const { s, frames } = setup();
    s.setWatched(true);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(frames).toHaveLength(3);
    await s.stop();
  });

  it('sin página espera; con página nueva (relogin) se vuelve a enganchar', async () => {
    const page: { current?: Page } = {};
    const { s, sessions, frames } = setup(page);
    s.setWatched(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessions).toHaveLength(0);

    page.current = fakePage();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sessions).toHaveLength(1);
    expect(frames).toHaveLength(1);

    page.current = fakePage();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessions[0]!.detached).toBe(true);
    expect(sessions).toHaveLength(2);
    await s.stop();
  });

  it('solo mira: nunca usa métodos de entrada (clics, teclado)', async () => {
    const { s, sessions } = setup();
    s.setWatched(true);
    await vi.advanceTimersByTimeAsync(12_000);
    await s.stop();
    const methods = sessions.flatMap((c) => c.calls);
    expect(methods.every((m) => m.startsWith('Page.'))).toBe(true);
    expect(methods.some((m) => m.startsWith('Input.'))).toBe(false);
  });
});
